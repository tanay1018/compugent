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
 * Perception uses the accessibility tree rather than the DOM: the same node
 * shape is available from macOS AX and Windows UIA, and it is roughly 10x
 * smaller than raw markup.
 *
 * Actions are real input events dispatched at the node's coordinates rather
 * than element.click(), so the app's own handlers run, and the same primitive
 * serves operator input forwarding.
 */

/**
 * Find a human-readable label for a node, with its relation. Runs in-page.
 *
 * On table-layout apps the accessibility tree exposes inputs with no name
 * (e.g. the target app's member lookup field); "Member ID" is just the text of
 * the neighbouring cell. A desktop driver would compute the same relation
 * geometrically.
 */
const NEARBY_FN = `function () {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const out = { nearby: '', rel: '', inputType: '' };

  // StaticText nodes resolve to DOM text nodes, which have no closest() or
  // previousElementSibling. Start from the parent element so extracted values
  // (e.g. a balance in a table cell) can be anchored.
  const el = this.nodeType === 3 ? this.parentElement : this;
  if (!el || !el.getAttribute) return out;

  // Captured first: for an unlabelled control the input type may be all we have.
  out.inputType = el.type ? String(el.type).toLowerCase() : '';

  const withType = (o) => Object.assign({}, o, { inputType: out.inputType });
  const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
  if (aria) return withType({ nearby: clean(aria), rel: 'labelledBy' });
  if (el.id) {
    const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (lab) return withType({ nearby: clean(lab.textContent), rel: 'labelledBy' });
  }
  const wrap = el.closest && el.closest('label');
  if (wrap) return withType({ nearby: clean(wrap.textContent), rel: 'labelledBy' });

  // Legacy table layout: the label is the previous cell in the same row.
  const td = el.closest && el.closest('td');
  if (td) {
    for (let p = td.previousElementSibling; p; p = p.previousElementSibling) {
      const t = clean(p.textContent);
      if (t) return withType({ nearby: t, rel: 'inSameRowAs' });
    }
    const row = td.closest('tr');
    if (row && row.previousElementSibling) {
      // First cell only. The row's full textContent includes the value
      // ("Savings$4,182.55"), which would put run data into the anchor.
      const firstCell = row.previousElementSibling.querySelector('td');
      const t = clean(firstCell ? firstCell.textContent : '');
      if (t) return withType({ nearby: t, rel: 'follows' });
    }
  }
  for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
    const t = clean(p.textContent);
    if (t) return withType({ nearby: t, rel: 'precededBy' });
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
    // Input goes over raw CDP, so Playwright's auto-waiting never sees the
    // resulting navigations. Track them here instead.
    cdp.on('Page.frameNavigated', () => { surface.lastNavAt = Date.now(); });
    cdp.on('Page.loadEventFired', () => { surface.lastNavAt = Date.now(); });
    // Track in-flight requests. readyState is 'complete' before an async table
    // has fetched its rows, and observing in that gap shows an empty screen.
    cdp.send('Network.enable').catch(() => {});
    cdp.on('Network.requestWillBeSent', () => { surface.inFlight += 1; });
    const settled = () => { surface.inFlight = Math.max(0, surface.inFlight - 1); surface.lastNetAt = Date.now(); };
    cdp.on('Network.loadingFinished', settled);
    cdp.on('Network.loadingFailed', settled);
    return surface;
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  private async frames(): Promise<FrameInfo[]> {
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    const out: FrameInfo[] = [];
    // Key frames by id, not index (order is not stable across versions). The
    // frameset root has an empty name, which could collide with a child frame.
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
    /** Anchoring runs as a separate, budgeted pass (see below). */
    const candidates: UINode[] = [];
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

        // Truncate long prose: it is never a target or an output, and one
        // untruncated product description pushed a run to 124K input tokens.
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

        // Anchor named controls too: browsers synthesise names (Chrome reports
        // "Submit" for an <input type="image"> with no alt text), so recording
        // both name and anchor lets a descriptor survive either one changing.
        // Costs two CDP round trips per node; a candidate for batching.
        if (ACTIONABLE.has(role) || role === 'text' || role === 'cell') candidates.push(node);
        nodes.push(node);
      }
    }

    /**
     * Anchor pass, in priority order within a budget.
     *
     * Priority is by how much the anchor adds: unnamed controls first (the
     * anchor is their only identity), then cells (half of a label/value pair),
     * then named controls. Enriching in document order let ~1500 navigation
     * links on a Wikipedia article use up the budget before any infobox cell.
     */
    const priority = (n: UINode) =>
      ACTIONABLE.has(n.role) && n.name === '' ? 0   // anonymous control: the anchor IS its identity
      : n.role === 'cell' ? 1                       // label/value pair: where outputs live
      : ACTIONABLE.has(n.role) ? 2                  // named control: its name already works
      : 3;                                          // loose text: rarely either
    const budget = Number(process.env.MAX_ANCHOR_NODES ?? 260);
    for (const node of candidates.sort((a, b) => priority(a) - priority(b)).slice(0, budget)) {
      const enriched = await this.nearbyText(node.handle as number);
      if (!enriched) continue;
      if (enriched.nearby) { node.anchorText = enriched.nearby; node.anchorRelation = enriched.rel; }
      if (enriched.inputType) node.inputType = enriched.inputType;
    }

    return {
      surfaceKind: 'web',
      capturedAt: new Date().toISOString(),
      frames, nodes,
      location: this.page.url(),
    };
  }

  private async nearbyText(backendNodeId: number): Promise<{ nearby: string; rel: string; inputType?: string } | null> {
    try {
      const { object } = await this.cdp.send('DOM.resolveNode', { backendNodeId });
      if (!object.objectId) return null;
      const r = await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration: NEARBY_FN, returnByValue: true,
      });
      const v = r.result?.value as { nearby?: string; rel?: string; inputType?: string } | undefined;
      if (!v) return null;
      // Keep the input type even without a label: it may mark a password field.
      if (!v.nearby || !v.rel) return v.inputType ? { nearby: '', rel: '', inputType: v.inputType } : null;
      return { nearby: v.nearby, rel: v.rel, ...(v.inputType ? { inputType: v.inputType } : {}) };
    } catch {
      return null;
    }
  }

  /** Pure; delegates to the shared resolver so web and desktop cannot drift. */
  resolve(observation: Observation, target: TargetDescriptor, params?: Record<string, unknown>): ResolveResult {
    return resolveTarget(observation, target, params);
  }

  private async centreOf(node: UINode): Promise<{ x: number; y: number }> {
    // Scroll first: getBoxModel returns layout coordinates, so a click on an
    // element below the fold would land outside the viewport without error.
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
      // Select the field's contents before inserting, so a prefilled value is
      // replaced rather than appended to. A raw Cmd+A key event over CDP does
      // not reliably trigger select-all.
      try {
        const { object } = await this.cdp.send('DOM.resolveNode', { backendNodeId: node.handle as number });
        if (object.objectId) {
          await this.cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId, returnByValue: true,
            functionDeclaration: `function () {
              this.focus && this.focus();
              if (typeof this.select === 'function') { this.select(); return true; }
              if (this.isContentEditable) {
                const r = document.createRange(); r.selectNodeContents(this);
                const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return true;
              }
              return false;
            }`,
          });
        }
      } catch { /* fall through -- insertText still works on an empty field */ }
      await this.cdp.send('Input.insertText', { text: action.text ?? '' });
    }
    if (action.kind === 'press' && action.key) {
      for (const type of ['keyDown', 'keyUp'] as const) {
        await this.cdp.send('Input.dispatchKeyEvent', { type, key: action.key, code: action.key });
      }
    }
  }

  /** Viewport centre of a node. The operator console works in raw coordinates. */
  async boundsOf(node: UINode): Promise<{ x: number; y: number }> {
    return this.centreOf(node);
  }

  /** Read a control's live value. Used by tests; the a11y tree lags input. */
  async valueOf(r: { ok: boolean; node?: UINode }): Promise<string> {
    if (!r.ok || !r.node) return '';
    const { object } = await this.cdp.send('DOM.resolveNode', { backendNodeId: r.node.handle as number });
    if (!object.objectId) return '';
    const out = await this.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: 'function () { return String(this.value ?? this.textContent ?? ""); }',
    });
    return String((out.result?.value as string) ?? '');
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: false });
  }

  /** @internal — updated from CDP navigation events. */
  lastNavAt = 0;
  /** @internal — requests still outstanding, and when one last completed. */
  inFlight = 0;
  lastNetAt = 0;

  /**
   * Wait for the document to be ready and navigation to go quiet. The quiet
   * period covers chained redirects (lookup -> interstitial -> detail).
   */
  async waitForStable({ timeoutMs = 15000, quietMs = 150, graceMs = 400,
                       networkQuietMs = 350, networkDeadlineMs = 2500 } = {}): Promise<void> {
    // A CDP click returns before navigation starts, so allow a short grace
    // window before treating the page as settled.
    const startedAt = Date.now();
    const navAtEntry = this.lastNavAt;
    const deadline = startedAt + timeoutMs;

    while (Date.now() < deadline) {
      const navigated = this.lastNavAt !== navAtEntry;
      // Inside the grace window with no navigation yet: keep waiting.
      if (!navigated && Date.now() - startedAt < graceMs) {
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }
      const ready = await this.page.evaluate(() => document.readyState === 'complete').catch(() => false);
      // Ready, navigation quiet, and no requests in flight. The network check
      // is best effort with its own short deadline, because real sites keep
      // firing analytics requests and never go fully idle.
      const waitedLongEnough = Date.now() - startedAt > networkDeadlineMs;
      const netQuiet = waitedLongEnough || (this.inFlight === 0 && Date.now() - this.lastNetAt > networkQuietMs);
      if (ready && Date.now() - this.lastNavAt > quietMs && netQuiet) return;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  /**
   * Observe until the predicate holds. Returns the matching observation, or
   * null on timeout; the caller decides what a timeout means.
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
  // An operator takes over this same session rather than a new one.

  private streaming = false;

  async startStream(onFrame: (jpegBase64: string) => void): Promise<void> {
    if (this.streaming) return;
    this.streaming = true;
    this.cdp.on('Page.screencastFrame', (f: any) => {
      onFrame(f.data);
      // Each frame must be acked or Chrome stops sending. Frames are only sent
      // on change.
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
   * Inject operator input as raw coordinates and keys. Whether the operator
   * may drive is checked by the control token, not here.
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
   * Record what a human does in this session as labelled actions ("typed into
   * Member ID") rather than pixels, using capture-phase DOM listeners and the
   * same label lookup as perception.
   *
   * These listeners also fire for agent input (we dispatch real events), so
   * the caller attributes events by who holds the control token.
   */
  async installOperatorCapture(onEvent: (e: { kind: string; label: string; tag: string; value?: string }) => void): Promise<void> {
    await this.page.exposeBinding('__cua_op', (_src, ev) => {
      onEvent(ev as { kind: string; label: string; tag: string; value?: string });
    });
    await this.page.addInitScript(`(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      const labelFor = (el) => {
        if (!el || !el.getAttribute) return '';
        // Prefer the nearest control; a click on a layout container would
        // otherwise be logged as a chunk of page text.
        const ctl = el.closest && el.closest('a,button,input,select,textarea,[role=button],[role=link]');
        const t = ctl || el;
        const a = t.getAttribute && (t.getAttribute('aria-label') || t.getAttribute('title') || t.getAttribute('alt'));
        if (a) return clean(a);
        if (t.value && (t.type === 'submit' || t.type === 'button')) return clean(t.value);
        const td = t.closest && t.closest('td');
        if (td) for (let p = td.previousElementSibling; p; p = p.previousElementSibling) {
          const x = clean(p.textContent); if (x) return x;
        }
        const own = clean(t.textContent);
        // Only trust element text when it reads like a label, not a paragraph.
        if (ctl && own && own.length <= 40) return own;
        if (!ctl) return '';
        return own.slice(0, 40);
      };
      const send = (kind, e) => {
        const el = e.target;
        if (!el || !el.tagName) return;
        const label = labelFor(el);
        const tag = el.tagName.toLowerCase();
        const isSecret = /password|hidden/i.test(el.type || '');
        try {
          window.__cua_op({
            kind, tag, label,
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
