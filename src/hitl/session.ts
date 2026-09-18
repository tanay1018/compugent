import type { PlaywrightSurface } from '../surface/playwright.js';
import type { RunLog } from '../run/log.js';
import type { RawInput } from '../surface/types.js';
import { ControlToken } from './control.js';
import { redactText } from '../policy/allowlist.js';

/**
 * A live session a human can take over.
 *
 * The requirement that shapes this file: the operator must drive THE SAME
 * session the automation was using, not a fresh one. So the browser stays put
 * and what changes is only who is permitted to send it input. Nothing is
 * torn down, no state is re-established, no login is repeated.
 *
 * Every operator action lands in the SAME event log as the agent's, tagged
 * `actor: "operator"`. That is what makes a run reconstructable across a
 * handoff — the human's work is part of the history, not a side channel.
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
   * Is an automation loop currently executing?
   *
   * Decides WHO yields. With a loop running, only the loop may hand over — at a
   * step boundary, once its in-flight action has completed. With nothing
   * running there is no boundary to wait for, so control transfers at once.
   *
   * A setter rather than a field, because the dangerous case is the loop
   * STOPPING while a pause is outstanding: the operator has asked for control,
   * the loop will never reach another boundary, and nothing else was watching.
   * That left "Take Over" stuck on Yielding… forever. Clearing this now always
   * completes a pending handover.
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
      // Attribution by token, not by event: the agent's own clicks fire these
      // same DOM listeners, and only one actor can hold control at a time.
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

  /** A still of the current screen. The screencast is change-driven, so a
   *  static page emits nothing — an operator opening the console mid-incident
   *  would otherwise stare at black. */
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
   * Forward operator input into the live session — gated on the token. While
   * the agent holds control this does not leak through; it raises a pause
   * request instead, which is what makes barge-in safe rather than racy.
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
   * Block until the agent may act again.
   *
   * Used at STEP BOUNDARIES only. An action already in flight runs to
   * completion — you cannot take a click back halfway, and pretending
   * otherwise would put an event in the log with no clear actor.
   */
  async awaitAgentControl(): Promise<void> {
    if (this.control.canAgentAct) return;
    await new Promise<void>((resolve) => {
      this.control.onChange((e) => { if (e.to === 'agent') resolve(); });
    });
  }

  /**
   * Hand control back mid-DISCOVERY.
   *
   * Simpler than the replay case, and instructively so: there is no artifact
   * to re-localise against yet, so there is nothing to be lost about. The
   * model just observes wherever the human left things and carries on. Plans
   * are what create the resumption problem.
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
