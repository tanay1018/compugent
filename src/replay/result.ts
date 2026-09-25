/**
 * The replay result contract.
 *
 * What a calling agent gets back. Business outcomes such as "no such member"
 * are a separate variant from failures, not an error string.
 *
 *   success           the capability ran and produced its declared outputs
 *   business_outcome  a legitimate answer the caller must handle; not an error
 *   failed            something broke; carries step, expected, observed
 *   escalated         automation cannot safely proceed; a human is needed
 *
 * Using a discriminated union means a caller handling only `success` and
 * `failed` gets a type error.
 */

export type FailureCode =
  | 'input_invalid'        // caller passed something the contract forbids
  | 'not_approved'         // draft artifact, unattended invocation
  | 'waypoint_failed'      // never reached the state this step expects
  | 'target_not_found'     // the control is not on screen
  | 'target_ambiguous'     // the descriptor matches several controls
  | 'checkpoint_failed'    // steps ran but we did not arrive
  | 'output_missing'       // arrived, but a declared output is not readable
  | 'output_mismatch'      // arrived and read, but the record is not the one asked for
  | 'policy_blocked'       // the allowlist refused the action
  | 'app_error';           // the application itself failed

export interface StepReport {
  index: number;
  id: string;
  kind: string;
  target?: string;
  status: 'ok' | 'recovered' | 'failed' | 'skipped';
  ms: number;
  /** Which resolution tier found the control. Steps that rely on fallbacks need review. */
  resolvedVia?: string;
  note?: string;
}

export interface ReplayFailure {
  code: FailureCode;
  stepIndex?: number;
  stepId?: string;
  /** Human-readable, for debugging. */
  expected: string;
  observed: string;
  screenshot?: string;
}

export type ReplayResult =
  | { status: 'success'; runId: string; outputs: Record<string, unknown>; steps: StepReport[]; ms: number }
  | { status: 'business_outcome'; runId: string; outcome: string; message: string; steps: StepReport[]; ms: number }
  | { status: 'failed'; runId: string; failure: ReplayFailure; steps: StepReport[]; ms: number }
  | {
      status: 'escalated'; runId: string; reason: string; atStep?: number;
      /** Where it stopped and a screenshot, for the human picking it up. */
      context: { location: string; screenshot?: string; expected?: string };
      steps: StepReport[]; ms: number;
    };
