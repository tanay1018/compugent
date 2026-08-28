/**
 * The replay result contract.
 *
 * This is what an AI agent gets back, and its shape is the single most
 * important thing in the system after the artifact schema. The brief names the
 * failure mode directly: conflating "no such member" with a crash is the most
 * common design mistake here. So the contract makes them different variants,
 * not different values of an `error` string.
 *
 *   success           the capability ran and produced its declared outputs
 *   business_outcome  a legitimate answer the caller must handle. NOT an error
 *   failed            something broke; carries what step, expected, observed
 *   escalated         automation cannot safely proceed; a human is needed
 *
 * A caller that only handles `success` and `failed` will be forced by the type
 * system to notice that `business_outcome` exists.
 */

export type FailureCode =
  | 'input_invalid'        // caller passed something the contract forbids
  | 'not_approved'         // draft artifact, unattended invocation
  | 'waypoint_failed'      // never reached the state this step expects
  | 'target_not_found'     // the control is not on screen
  | 'target_ambiguous'     // the descriptor matches several controls
  | 'checkpoint_failed'    // steps ran but we did not arrive
  | 'output_missing'       // arrived, but a declared output is not readable
  | 'policy_blocked'       // the allowlist refused the action
  | 'app_error';           // the application itself failed

export interface StepReport {
  index: number;
  id: string;
  kind: string;
  target?: string;
  status: 'ok' | 'recovered' | 'failed' | 'skipped';
  ms: number;
  /** Which resolution tier actually found the control. A step that only ever
   *  succeeds via a fallback is a step whose descriptor needs review. */
  resolvedVia?: string;
  note?: string;
}

export interface ReplayFailure {
  code: FailureCode;
  stepIndex?: number;
  stepId?: string;
  /** Phrased for whoever is debugging this at 2am, months later. */
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
      /** Everything a human needs to pick this up: where it stopped, why, and
       *  what the screen looked like. */
      context: { location: string; screenshot?: string; expected?: string };
      steps: StepReport[]; ms: number;
    };
