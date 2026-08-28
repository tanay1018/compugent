import { chromium, type Browser, type Page, type CDPSession } from 'playwright';
import type { TargetDescriptor } from '../schema/target.js';
import type {
  Action, FrameInfo, Observation, RawInput, ResolveResult, Surface, SurfaceKind, UINode,
} from './types.js';
import { ACTIONABLE, INFORMATIONAL, normaliseWebRole } from './roles.js';
import { resolveTarget } from './resolve.js';

/**
 * Web surface driven through the Chrome DevTools Protocol.
 *
 * Perception is the ACCESSIBILITY TREE, not the DOM. That choice is what
 * makes the surface abstraction credible — the same node shape comes out of
 * macOS AXUIElement and Windows UIA — and it is ~10x cheaper in tokens than
 * feeding a model raw markup.
 *
 * Acting uses real input events dispatched at resolved coordinates rather
 * than element.click(). Same reason: it is the primitive that also serves the
 * visual fallback tier and operator input forwarding, and it exercises the
 * app the way a person does rather than bypassing its handlers.
 */

/**
 * Recovers a human-meaningful label for a control the platform exposes
 * anonymously. Runs in-page.
 *
 * This function is why the system works on legacy screens at all. Measured
 * against the bundled target app, the accessibility tree reports the member
 * lookup field as an unnamed `textbox` — the string "Member ID" is simply the
 * text of a neighbouring table cell, with no programmatic association. Walking
 * to that neighbour is what a human does visually, and it is the same
 * relation ("nearest label to the left") that a desktop driver would compute
 * geometrically.
 */
const NEARBY_FN = `function () {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const out = { nearby: '', rel: '' };

  // A StaticText accessibility node resolves to a DOM TEXT NODE, not an
  // element -- and text nodes have no closest()/previousElementSibling. Values
  // we need to EXTRACT (a balance in a table cell) are exactly these nodes, so
  // climbing to the parent element first is what makes outputs addressable.
  const el = this.nodeType === 3 ? this.parentElement : this;
  if (!el || !el.getAttribute) return out;

  const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
  if (aria) return { nearby: clean(aria), rel: 'labelledBy' };
  if (el.id) {
    const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (lab) return { nearby: clean(lab.textContent), rel: 'labelledBy' };
  }
  const wrap = el.closest && el.closest('label');
  if (wrap) return { nearby: clean(wrap.textContent), rel: 'labelledBy' };

  // Legacy table layout: the label is the previous cell in the same row.
  const td = el.closest && el.closest('td');
  if (td) {
    for (let p = td.previousElementSibling; p; p = p.previousElementSibling) {
      const t = clean(p.textContent);
      if (t) return { nearby: t, rel: 'inSameRowAs' };
    }
    const row = td.closest('tr');
    if (row && row.previousElementSibling) {
      // First cell only: the whole row's textContent concatenates label AND
      // value ("Savings$4,182.55"), which would bake this run's data into the
      // anchor and pin the artifact to one member.
      const firstCell = row.previousElementSibling.querySelector('td');
      const t = clean(firstCell ? firstCell.textContent : '');
      if (t) return { nearby: t, rel: 'follows' };
    }
  }
  for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
    const t = clean(p.textContent);
    if (t) return { nearby: t, rel: 'precededBy' };
  }
  return out;
}`;

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
}

export class PlaywrightSurface implements Surface {
  readonly kind: SurfaceKind = 'web';

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  static async launch(opts: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const page = await browser.newPage();
    await page.setViewportSize(opts.viewport ?? { width: 1024, height: 700 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const surface = new PlaywrightSurface(browser, page, cdp);
    // We drive the page with raw CDP input, so Playwright never learns that a
    // click triggered a navigation and its auto-waiting cannot help us. Track
    // navigation ourselves instead of guessing with a sleep.
    cdp.on('Page.frameNavigated', () => { surface.lastNavAt = Date.now(); });
    cdp.on('Page.loadEventFired', () => { surface.lastNavAt = Date.now(); });
    return surface;
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  private async frames(): Promise<FrameInfo[]> {
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    const out: FrameInfo[] = [];
    // Frames are keyed by id, never by index: frame ORDER is not stable across
    // app versions. The frameset root has an empty name, which would otherwise
    // collide with a child frame legitimately named "main".
    const walk = (n: any, depth: number): void => {
      out.push({
        id: n.frame.id,
        name: n.frame.name || (depth === 0 ? 'root' : String(n.frame.id).slice(0, 6)),
        url: n.frame.url,
      });
      for (const c of n.childFrames ?? []) walk(c, depth + 1);
    };
    walk(frameTree, 0);
    return out;
  }

  async observe(): Promise<Observation> {
    await this.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const frames = await this.frames();
    const nodes: UINode[] = [];
    let ref = 0;

    for (const f of frames) {
      let tree: { nodes: any[] };
      try {
        tree = (await this.cdp.send('Accessibility.getFullAXTree', { frameId: f.id })) as any;
      } catch {
        continue; // a frame can vanish mid-observation; that is not fatal
      }

      for (const ax of tree.nodes) {
        if (ax.ignored) continue;
        const raw = ax.role?.value;
        if (typeof raw !== 'string') continue;
        const role = normaliseWebRole(raw);
        if (!ACTIONABLE.has(role) && !INFORMATIONAL.has(role)) continue;

        // Long prose (a product description, a terms blob) is never a target
        // and never an output -- it is pure token cost. One page of untruncated
        // body copy took a discovery run to 124K input tokens.
        const name = String(ax.name?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const value = String(ax.value?.value ?? '').trim().slice(0, 200);
        // Informational nodes with no text carry nothing; actionable ones are
        // kept even when anonymous, because anchoring can still identify them.
        if (!ACTIONABLE.has(role) && name === '') continue;

        const states: UINode['states'][number][] = [];
        for (const p of ax.properties ?? []) {
          const n = p?.name;
          if (p?.value?.value === true &&
              (n === 'disabled' || n === 'focused' || n === 'checked' ||
               n === 'expanded' || n === 'readonly' || n === 'required')) {
            states.push(n);
          }
        }

        const node: UINode = {
          ref: ++ref, role, name, value, states, frame: f.name, handle: ax.backendDOMNodeId,
        };

        // Anchor EVERY actionable control, not just anonymous ones.
        //
        // The obvious optimisation -- skip enrichment when the node already has
        // an accessible name -- is wrong, because browsers synthesise names.
        // Chrome reports `name: "Submit"` for an <input type="image"> whose
        // author supplied no alt text at all. An artifact that trusted that
        // name would be pinned to a browser default rather than to app
        // content. Recording name AND anchor together is what makes the
        // descriptor survive either one changing.
        //
        // Cost is two CDP round trips per control. Bounded in practice
        // (actionable controls are a small fraction of a screen) but it is the
        // obvious place to batch if a wide results grid ever makes it hurt.
        // Text and cells are anchored too, because OUTPUTS live in them. To
        // extract a savings balance from a table layout you need "the cell in
        // the row whose label says Savings" -- the value itself is the payload,
        // never the identity.
        const anchorable = ACTIONABLE.has(role) || role === 'text' || role === 'cell';
        if (anchorable && ax.backendDOMNodeId !== undefined && nodes.length < 250) {
          const enriched = await this.nearbyText(ax.backendDOMNodeId);
          if (enriched) { node.anchorText = enriched.nearby; node.anchorRelation = enriched.rel; }
        }
        nodes.push(node);
      }
    }

    return {
      surfaceKind: 'web',
      capturedAt: new Date().toISOString(),
      frames, nodes,
      location: this.page.url(),
    };
  }

  private async nearbyText(backendNodeId: number): Promise<{ nearby: string; rel: string } | null> {
    try {
      const { object } = await this.cdp.send('DOM.resolveNode', { backendNodeId });
      if (!object.objectId) return null;
      const r = await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration: NEARBY_FN, returnByValue: true,
      });
      const v = r.result?.value as { nearby?: string; rel?: string } | undefined;
      if (!v?.nearby || !v.rel) return null;
      return { nearby: v.nearby, rel: v.rel };
    } catch {
      return null;
    }
  }

  /** Pure; delegates to the shared resolver so web and desktop cannot drift. */
  resolve(observation: Observation, target: TargetDescriptor, params?: Record<string, unknown>): ResolveResult {
    return resolveTarget(observation, target, params);
  }

  private async centreOf(node: UINode): Promise<{ x: number; y: number }> {
    // Scroll first. getBoxModel reports LAYOUT coordinates, so an element below
    // the fold yields a point outside the viewport and the dispatched click
    // lands on nothing -- silently, because the event is still delivered. The
    // bundled target app never caught this: everything fits on one screen.
    await this.cdp
      .send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.handle as number })
      .catch(() => {});
    const { model } = await this.cdp.send('DOM.getBoxModel', { backendNodeId: node.handle as number });
    const q = model.content as number[];
    return {
      x: ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4,
      y: ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4,
    };
  }

  async act(_observation: Observation, node: UINode, action: Action): Promise<void> {
    if (action.kind === 'navigate') {
      if (!action.url) throw new Error('navigate action requires a url');
      return this.navigate(action.url);
    }
    if (action.kind === 'read') return;

    if (action.kind === 'select') {
      // A native <select> cannot be driven by synthetic clicks in a way that
      // survives headless; set the value and fire the event the app listens for.
      const { object } = await this.cdp.send('DOM.resolveNode', { backendNodeId: node.handle as number });
      if (!object.objectId) throw new Error('could not resolve select element');
      await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: `function (v) {
          for (const o of this.options) {
            if (o.value === v || o.text === v) {
              this.value = o.value;
              this.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
          return false;
        }`,
        arguments: [{ value: action.text ?? '' }],
      });
      return;
    }

    const { x, y } = await this.centreOf(node);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

    if (action.kind === 'type') {
      // Select-all then overwrite, so replaying into a pre-filled field is
      // idempotent rather than appending to whatever was already there.
      for (const type of ['keyDown', 'keyUp'] as const) {
        await this.cdp.send('Input.dispatchKeyEvent', {
          type, modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
        });
      }
      await this.cdp.send('Input.insertText', { text: action.text ?? '' });
    }
    if (action.kind === 'press' && action.key) {
      for (const type of ['keyDown', 'keyUp'] as const) {
        await this.cdp.send('Input.dispatchKeyEvent', { type, key: action.key, code: action.key });
      }
    }
  }

  /** Viewport centre of a node. Exposed because an operator console forwards
   *  RAW COORDINATES -- it has no notion of selectors or descriptors. */
  async boundsOf(node: UINode): Promise<{ x: number; y: number }> {
    return this.centreOf(node);
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: false });
  }

  /** @internal — updated from CDP navigation events. */
  lastNavAt = 0;

  /**
   * Settle helper. Waits for the document to be ready AND for navigation
   * activity to go quiet, rather than sleeping for a guessed interval.
   *
   * The quiet period matters because a legacy app can chain redirects
   * (lookup -> interstitial -> detail); returning after the first one would
   * observe a page that is about to be replaced.
   */
  async waitForStable({ timeoutMs = 15000, quietMs = 150, graceMs = 400 } = {}): Promise<void> {
    // A click dispatched over CDP returns before the browser has even started
    // navigating. Without a grace window, this returns instantly against the
    // page that is about to be replaced -- and the caller observes stale state.
    const startedAt = Date.now();
    const navAtEntry = this.lastNavAt;
    const deadline = startedAt + timeoutMs;

    while (Date.now() < deadline) {
      const navigated = this.lastNavAt !== navAtEntry;
      // Still inside the grace window and nothing has moved yet: keep waiting,
      // a navigation may be in flight.
      if (!navigated && Date.now() - startedAt < graceMs) {
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }
      const ready = await this.page.evaluate(() => document.readyState === 'complete').catch(() => false);
      if (ready && Date.now() - this.lastNavAt > quietMs) return;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  /**
   * Wait until an observation satisfies a predicate.
   *
   * This is the primitive replay actually needs: a checkpoint is a condition
   * on observable state, so waiting for it and asserting it are the same
   * operation. Returns the satisfying observation, or null on timeout — the
   * caller decides whether a timeout is a recoverable condition or a failure,
   * because that distinction belongs to the error taxonomy, not here.
   */
  async waitUntil(
    predicate: (o: Observation) => boolean,
    { timeoutMs = 15000, pollMs = 250 } = {},
  ): Promise<Observation | null> {
    const deadline = Date.now() + timeoutMs;
    let last: Observation | null = null;
    while (Date.now() < deadline) {
      last = await this.observe();
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }

  // --- Handoff -----------------------------------------------------------
  // The session outlives the automation that started it, so an operator takes
  // over THIS session rather than a fresh one.

  private streaming = false;

  async startStream(onFrame: (jpegBase64: string) => void): Promise<void> {
    if (this.streaming) return;
    this.streaming = true;
    this.cdp.on('Page.screencastFrame', (f: any) => {
      onFrame(f.data);
      // Acking is mandatory: without it Chrome stops emitting after a couple
      // of frames. The stream is change-driven, so an idle page costs nothing.
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 60, maxWidth: 1024, maxHeight: 700, everyNthFrame: 1,
    });
  }

  async stopStream(): Promise<void> {
    if (!this.streaming) return;
    this.streaming = false;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  /**
   * Inject operator input. Note this takes RAW coordinates and keys — it has
   * no idea what it is clicking, by design. Whether the operator is allowed to
   * drive is the control token's business, not the Surface's.
   */
  async dispatchRawInput(e: RawInput): Promise<void> {
    if (e.type === 'mouse') {
      const type = e.action === 'down' ? 'mousePressed' : e.action === 'up' ? 'mouseReleased' : 'mouseMoved';
      await this.cdp.send('Input.dispatchMouseEvent', {
        type, x: e.x, y: e.y, button: e.button ?? 'left', clickCount: e.action === 'move' ? 0 : 1,
      });
    } else if (e.type === 'key') {
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: e.action === 'down' ? 'keyDown' : 'keyUp', key: e.key, code: e.key,
      });
    } else {
      await this.cdp.send('Input.insertText', { text: e.text });
    }
  }

  /**
   * Capture what a HUMAN does in this session, semantically.
   *
   * Recording pixels would satisfy nobody: 3.6 asks us to record what the
   * human did, and in a regulated environment an auditor needs "typed into the
   * Member ID field", not a video. Hooking DOM events at the capture phase and
   * resolving a label for the target gives the same vocabulary the agent's own
   * steps use, so both actors land in one log with one shape.
   *
   * Note this fires for agent-driven input too, because we dispatch real
   * events. Attribution is therefore decided by WHO HOLDS THE TOKEN, not by
   * the event — which is the honest answer, and the reason the control token
   * is the single source of truth about who is driving.
   */
  async installOperatorCapture(onEvent: (e: { kind: string; label: string; tag: string; value?: string }) => void): Promise<void> {
    await this.page.exposeBinding('__cua_op', (_src, ev) => {
      onEvent(ev as { kind: string; label: string; tag: string; value?: string });
    });
    await this.page.addInitScript(`(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      const labelFor = (el) => {
        if (!el || !el.getAttribute) return '';
        const a = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt');
        if (a) return clean(a);
        if (el.value && el.type === 'submit') return clean(el.value);
        const td = el.closest && el.closest('td');
        if (td) for (let p = td.previousElementSibling; p; p = p.previousElementSibling) {
          const t = clean(p.textContent); if (t) return t;
        }
        return clean(el.textContent);
      };
      const send = (kind, e) => {
        const el = e.target;
        if (!el || !el.tagName) return;
        const tag = el.tagName.toLowerCase();
        const isSecret = /password|hidden/i.test(el.type || '');
        try {
          window.__cua_op({
            kind, tag, label: labelFor(el),
            ...(kind === 'input' && !isSecret ? { value: String(el.value ?? '').slice(0, 80) } : {}),
          });
        } catch {}
      };
      document.addEventListener('click', (e) => send('click', e), true);
      document.addEventListener('change', (e) => send('input', e), true);
      document.addEventListener('submit', (e) => send('submit', e), true);
    })()`);
  }

  async close(): Promise<void> {
    await this.stopStream();
    await this.browser.close();
  }
}
