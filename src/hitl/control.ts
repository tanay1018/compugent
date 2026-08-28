/**
 * Who is driving?
 *
 * The brief asks for a way to know who is (or should be) in control. That is
 * this file, and its central property is that THERE IS NO "BOTH" STATE. Input
 * is gated on the token: while automation holds it, operator input does not
 * leak through — it raises a pause request instead. While the operator holds
 * it, the executor is hard-blocked.
 *
 * Barge-in is atomic at STEP boundaries. You cannot yank control out of a
 * half-finished click; a pause lands either during a wait (interruptible) or
 * after the in-flight action completes (atomic). That is what keeps the event
 * log honest: every event has an unambiguous actor.
 */
export type ControlState =
  | 'agent'            // automation drives
  | 'pause_requested'  // a human asked for control; agent yields at the next boundary
  | 'operator'         // the human drives THIS session
  | 'resume_requested' // the human handed back; we must re-localise before acting
  | 'relocalizing'     // working out where the human left us
  | 'closed';

export type Holder = 'agent' | 'operator' | 'nobody';

export type ControlEvent = {
  from: ControlState;
  to: ControlState;
  by: 'agent' | 'operator' | 'system';
  reason: string;
};

const LEGAL: Record<ControlState, ControlState[]> = {
  agent: ['pause_requested', 'closed'],
  pause_requested: ['operator', 'agent', 'closed'], // 'agent' = the request was withdrawn
  operator: ['resume_requested', 'closed'],
  resume_requested: ['relocalizing', 'operator', 'closed'],
  relocalizing: ['agent', 'operator', 'closed'],
  closed: [],
};

export class ControlToken {
  private _state: ControlState = 'agent';
  private readonly listeners: Array<(e: ControlEvent) => void> = [];

  get state(): ControlState { return this._state; }

  /** Nobody holds the token mid-transfer. Acting then is a bug, not a race. */
  get holder(): Holder {
    switch (this._state) {
      case 'agent': return 'agent';
      case 'operator': return 'operator';
      case 'pause_requested': return 'agent'; // still the agent's, until it yields
      default: return 'nobody';
    }
  }

  get canAgentAct(): boolean { return this._state === 'agent'; }
  get canOperatorAct(): boolean { return this._state === 'operator'; }
  /** Checked by the executor between steps — never mid-action. */
  get pauseRequested(): boolean { return this._state === 'pause_requested'; }

  onChange(fn: (e: ControlEvent) => void): void { this.listeners.push(fn); }

  private go(to: ControlState, by: ControlEvent['by'], reason: string): void {
    const from = this._state;
    if (!LEGAL[from].includes(to)) {
      throw new Error(`illegal control transition ${from} -> ${to} (${reason})`);
    }
    this._state = to;
    for (const l of this.listeners) l({ from, to, by, reason });
  }

  /** A human asks to take over. Does not transfer control yet. */
  requestPause(reason = 'operator requested control'): void { this.go('pause_requested', 'operator', reason); }

  /** The system raises the request itself: stuck, or a risky step needs a decision. */
  escalate(reason: string): void {
    if (this._state === 'agent') this.go('pause_requested', 'system', reason);
  }

  /** The executor reached a safe boundary and yielded. */
  yieldToOperator(reason = 'automation paused at a step boundary'): void { this.go('operator', 'agent', reason); }

  /** The request was withdrawn before a boundary was reached. */
  cancelPause(reason = 'pause withdrawn'): void { this.go('agent', 'system', reason); }

  /** The human is done. Control does NOT return to the agent yet — the app
   *  could be anywhere now, so re-localisation comes first. */
  requestResume(reason = 'operator handed control back'): void { this.go('resume_requested', 'operator', reason); }

  beginRelocalize(): void { this.go('relocalizing', 'system', 'establishing where the operator left the session'); }

  /** Only after re-localisation succeeded. */
  returnToAgent(reason: string): void { this.go('agent', 'system', reason); }

  /** Re-localisation failed; the human keeps the session. */
  handBackToOperator(reason: string): void { this.go('operator', 'system', reason); }

  close(reason = 'session ended'): void { if (this._state !== 'closed') this.go('closed', 'system', reason); }
}
