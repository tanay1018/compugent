import type { CapabilityArtifact } from '../schema/artifact.js';
import { evaluateAssertion } from '../schema/assertion.js';
import type { Observation } from '../surface/types.js';

/**
 * Work out where a run is after an operator hands back control.
 *
 * The operator may have moved forward, backward, somewhere unrelated, or
 * finished the task, so the old step index is not used. Instead the current
 * screen is checked against the checkpoint and each step's waypoint. If the
 * result is ambiguous in a way that matters, re-localisation stops rather
 * than guessing.
 */
export type Localization =
  | { kind: 'completed'; detail: string }
  | { kind: 'located'; stepIndex: number; detail: string }
  | { kind: 'ambiguous'; stepIndexes: number[]; detail: string }
  | { kind: 'off_plan'; detail: string };

export function localize(a: CapabilityArtifact, o: Observation): Localization {
  // Check the checkpoint first: if the operator finished the task, only
  // outputs need reading. Incomplete artifacts have none, so skip to waypoints.
  if (a.checkpoint) {
    const done = evaluateAssertion(o, a.checkpoint);
    if (done.held) return { kind: 'completed', detail: `checkpoint holds (${done.detail})` };
  }

  const matches = a.steps.filter((s) => s.waypoint && evaluateAssertion(o, s.waypoint).held).map((s) => s.index);

  if (matches.length === 1) {
    return { kind: 'located', stepIndex: matches[0]!, detail: `waypoint for step ${matches[0]} holds` };
  }
  if (matches.length > 1) {
    // Several steps can share a screen (type into a field, click the button
    // beside it). If all candidates are safe to redo, resume at the earliest.
    // If one is irreversible, we cannot tell whether it ran, so stop.
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
 * Is it safe to resume from here? Covers the case where the operator already
 * submitted a form and localisation lands before that step.
 *
 *   read / reversible   free to re-execute
 *   irreversible        only if its idempotency probe gives a definite answer
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
