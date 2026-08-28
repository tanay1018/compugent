import type { CapabilityArtifact } from '../schema/artifact.js';
import { evaluateAssertion } from '../schema/assertion.js';
import type { Observation } from '../surface/types.js';

/**
 * Where are we?
 *
 * After a human takes over, the step index is meaningless. They may have gone
 * forward, gone backward, wandered somewhere unrelated, finished the task
 * outright, or — the adversarial case — moved somewhere that superficially
 * resembles the plan. So resumption is not "continue at k+1"; it is a
 * LOCALISATION problem:
 *
 *     The plan is a map, not a program counter.
 *     You never trust the index; you trust the observed state.
 *     When observation is ambiguous, you stop.
 *
 * That last line is the safety property. Guessing where you are, in a bank,
 * is worse than admitting you do not know.
 */
export type Localization =
  | { kind: 'completed'; detail: string }
  | { kind: 'located'; stepIndex: number; detail: string }
  | { kind: 'ambiguous'; stepIndexes: number[]; detail: string }
  | { kind: 'off_plan'; detail: string };

export function localize(a: CapabilityArtifact, o: Observation): Localization {
  // Checked FIRST: a human who simply finished the task is the happiest
  // outcome, and resuming into a completed flow would redo work.
  const done = evaluateAssertion(o, a.checkpoint);
  if (done.held) return { kind: 'completed', detail: `checkpoint holds (${done.detail})` };

  const matches = a.steps.filter((s) => s.waypoint && evaluateAssertion(o, s.waypoint).held).map((s) => s.index);

  if (matches.length === 1) {
    return { kind: 'located', stepIndex: matches[0]!, detail: `waypoint for step ${matches[0]} holds` };
  }
  if (matches.length > 1) {
    // Several steps can legitimately share a screen — typing into a field and
    // clicking the button beside it both happen on the same form, so their
    // waypoints both hold. Refusing outright would make resumption impossible
    // for any multi-step screen.
    //
    // Ambiguity only MATTERS when the consequences differ. If everything from
    // the earliest candidate onward is safe to redo, resume there: re-typing a
    // member ID costs nothing. If an irreversible step is in the ambiguous
    // set, we genuinely cannot tell whether it has run, and we stop.
    const earliest = Math.min(...matches);
    const risky = a.steps.filter((s) => matches.includes(s.index) && s.effect === 'irreversible').map((s) => s.index);
    if (risky.length === 0) {
      return {
        kind: 'located',
        stepIndex: earliest,
        detail: `steps ${matches.join(', ')} share this screen; resuming at the earliest (${earliest}) — all are safe to redo`,
      };
    }
    return {
      kind: 'ambiguous',
      stepIndexes: matches,
      detail:
        `waypoints for steps ${matches.join(', ')} all hold and step(s) ${risky.join(', ')} are irreversible; ` +
        `replay cannot tell whether they have already run`,
    };
  }
  return { kind: 'off_plan', detail: `no waypoint holds at ${o.location}` };
}

export interface ReentryPlan {
  resumeAt: number;
  /** Irreversible steps whose probe says the effect already happened. */
  willSkip: number[];
  /** Irreversible steps that have NOT happened and need an operator decision. */
  needsApproval: number[];
  /** Irreversible steps we cannot make a determination about. */
  indeterminate: number[];
}

export type ReentryDecision =
  | { safe: true; plan: ReentryPlan }
  | { safe: false; reason: string };

/**
 * Is it safe to hand control back and resume here?
 *
 * The scenario this exists for: the operator already submitted the form, then
 * handed back. Localisation lands us before that step. Resuming naively opens
 * a SECOND sub-account — in a bank, with a customer's money. So re-entry is
 * effect-aware:
 *
 *   read / reversible   free to re-execute
 *   irreversible        only after its idempotency probe answers "already
 *                       done?" — and an indeterminate answer is not a yes
 */
export function planReentry(a: CapabilityArtifact, loc: Localization, o: Observation): ReentryDecision {
  if (loc.kind === 'off_plan') {
    return { safe: false, reason: `cannot resume: ${loc.detail}. Automation will not guess its position.` };
  }
  if (loc.kind === 'ambiguous') {
    return { safe: false, reason: `cannot resume: ${loc.detail}` };
  }
  if (loc.kind === 'completed') {
    return { safe: true, plan: { resumeAt: a.steps.length + 1, willSkip: [], needsApproval: [], indeterminate: [] } };
  }

  const plan: ReentryPlan = { resumeAt: loc.stepIndex, willSkip: [], needsApproval: [], indeterminate: [] };
  for (const s of a.steps) {
    if (s.index < loc.stepIndex) continue;
    if (s.effect !== 'irreversible') continue;
    if (!s.idempotencyProbe) { plan.indeterminate.push(s.index); continue; }
    // Probed against the state we can see NOW. A probe that only becomes
    // answerable later is re-evaluated by the engine when it reaches the step.
    (evaluateAssertion(o, s.idempotencyProbe).held ? plan.willSkip : plan.needsApproval).push(s.index);
  }

  if (plan.indeterminate.length) {
    return {
      safe: false,
      reason:
        `cannot resume: step(s) ${plan.indeterminate.join(', ')} are irreversible with no idempotency probe, ` +
        `so replay cannot tell whether the operator already performed them`,
    };
  }
  return { safe: true, plan };
}
