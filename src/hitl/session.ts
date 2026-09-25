import type { PlaywrightSurface } from '../surface/playwright.js';
import type { RunLog } from '../run/log.js';
import type { RawInput } from '../surface/types.js';
import { ControlToken } from './control.js';
import { redactText } from '../policy/allowlist.js';

/**
 * A live session a human can take over.
 *
 * The operator drives the same browser session the automation was using; only
 * the permission to send input changes hands. Operator actions go into the
 * same event log as the agent's, tagged `actor: "operator"`.
 */
export interface EscalationContext {
  reason: string;
  capability: string;
  atStep?: number;
  expected?: string;
  location: string;
  screenshot?: string;
}

export class HandoffSession {
  readonly control = new ControlToken();
  private context: EscalationContext | null = null;
  private frameListeners: Array<(f: string) => void> = [];
  private captureInstalled = false;
  /**
   * Whether an automation loop is running. If so, the loop hands over at its
   * next step boundary; if not, control transfers immediately.
   *
   * A setter so that a loop stopping with a pause pending completes the
   * handover (otherwise the console would wait for a boundary that never comes).
   */
  private _agentActive = false;
  get agentActive(): boolean { return this._agentActive; }
  set agentActive(v: boolean) {
    this._agentActive = v;
    if (!v && this.control.pauseRequested) {
      this.log.append('system', 'control.autoyield', {
        note: 'automation stopped while a handover was pending',
      });
      this.control.yieldToOperator('automation stopped with a pause outstanding');
    }
  }

  constructor(
    private readonly surface: PlaywrightSurface,
    readonly log: RunLog,
  ) {
    this.control.onChange((e) => {
      this.log.append(e.by, 'control.transition', { from: e.from, to: e.to, reason: e.reason });
    });
  }

  /** Must run before navigation so the init script reaches every document. */
  async prepare(): Promise<void> {
    if (this.captureInstalled) return;
    this.captureInstalled = true;
    await this.surface.installOperatorCapture((ev) => {
      // Attribute by token holder: agent input fires the same DOM listeners.
      if (!this.control.canOperatorAct) return;
      this.log.append('operator', `manual.${ev.kind}`, {
        control: ev.label ? redactText(ev.label) : ev.tag,
        ...(ev.value !== undefined ? { value: redactText(ev.value) } : {}),
      });
    });
  }

  get escalation(): EscalationContext | null { return this.context; }

  /**
   * Raise an intervention request carrying enough context to act on: which
   * capability, which step, what it was waiting for, and the screen itself.
   */
  async escalate(ctx: Omit<EscalationContext, 'screenshot' | 'location'>): Promise<EscalationContext> {
    const obs = await this.surface.observe();
    const shot = this.log.saveScreenshot(await this.surface.screenshot(), 'escalation');
    this.context = { ...ctx, location: obs.location, screenshot: shot };
    this.control.escalate(ctx.reason);
    this.log.append('system', 'escalation.raised', { ...this.context });
    return this.context;
  }

  /** The executor yields at a step boundary — never mid-action. */
  yield(): void { this.control.yieldToOperator(); }

  /** A still of the current screen, since the screencast only sends frames on change. */
  async snapshot(): Promise<string> {
    return (await this.surface.screenshot()).toString('base64');
  }

  async startStreaming(): Promise<void> {
    await this.surface.startStream((frame) => { for (const l of this.frameListeners) l(frame); });
  }
  onFrame(fn: (jpegBase64: string) => void): () => void {
    this.frameListeners.push(fn);
    return () => { this.frameListeners = this.frameListeners.filter((f) => f !== fn); };
  }

  /**
   * Forward operator input, gated on the token. While the agent holds control
   * the input is not forwarded; it raises a pause request instead.
   */
  async operatorInput(e: RawInput): Promise<'sent' | 'pause_requested' | 'ignored'> {
    if (this.control.canOperatorAct) { await this.surface.dispatchRawInput(e); return 'sent'; }
    if (this.control.state === 'agent') {
      this.control.requestPause('operator interacted with the live session');
      this.log.append('operator', 'barge_in', { note: 'input withheld until the agent yields at a step boundary' });
      return 'pause_requested';
    }
    return 'ignored';
  }

  /**
   * Block until the agent may act again. Called at step boundaries only; an
   * in-flight action always completes, so each logged event has one actor.
   */
  async awaitAgentControl(): Promise<void> {
    if (this.control.canAgentAct) return;
    await new Promise<void>((resolve) => {
      this.control.onChange((e) => { if (e.to === 'agent') resolve(); });
    });
  }

  /**
   * Hand control back during discovery. No re-localisation is needed: there
   * is no plan yet, so the model just observes the current screen.
   */
  resumeDiscovery(): void {
    if (this.control.state !== 'resume_requested') return;
    this.control.beginRelocalize();
    this.control.returnToAgent('discovery continues from wherever the operator left the session');
  }

  async stop(): Promise<void> {
    await this.surface.stopStream();
    this.control.close();
  }
}
