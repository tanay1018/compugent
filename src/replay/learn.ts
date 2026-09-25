import type { CapabilityArtifact, OutcomeSpec, OutcomeClass } from '../schema/artifact.js';
import { OutcomeSpec as OutcomeSpecSchema } from '../schema/artifact.js';
import { evaluateAssertion, type StateAssertion } from '../schema/assertion.js';
import { describeNode } from '../discovery/describe.js';
import type { Observation } from '../surface/types.js';
import type { PlaywrightSurface } from '../surface/playwright.js';
import { norm } from '../surface/resolve.js';

/**
 * Learn outcome signatures by diffing observations.
 *
 *   run the happy path   -> baseline text
 *   run a probe input    -> probe text
 *   new text             -> the signature
 *
 * The wording is learned; the classification (answer, recoverable, fault,
 * escalate) is supplied by a human, since diffing cannot decide it.
 */

export interface OutcomeProbe {
  name: string;
  /** Supplied by a human, not inferred. */
  classification: OutcomeClass;
  inputs: Record<string, string>;
  message: string;
  /** For `recoverable`: dismiss the interstitial by clicking the new control. */
  recoverBy?: 'dismissNewControl' | 'wait' | 'retryStep';
}

/** Run an artifact's steps with outcome handling disabled, to see the raw state a probe produces. */
export async function executeRaw(
  a: CapabilityArtifact,
  inputs: Record<string, string>,
  surface: PlaywrightSurface,
  baseUrl: string,
): Promise<Observation> {
  await surface.navigate(baseUrl);
  await surface.waitForStable();
  for (const step of a.steps) {
    const obs = step.waypoint
      ? (await surface.waitUntil((o) => evaluateAssertion(o, step.waypoint as StateAssertion).held, { timeoutMs: 12000 })) ??
        (await surface.observe())
      : await surface.observe();
    if (!step.target) continue;
    const r = surface.resolve(obs, step.target);
    if (!r.ok) break; // the probe diverged earlier than the last step; that is the point
    const value = step.value?.from === 'literal' ? step.value.value
      : step.value?.from === 'param' ? inputs[step.value.param] ?? '' : undefined;
    await surface.act(obs, r.node, { kind: step.kind as never, ...(value !== undefined ? { text: value } : {}) });
    await surface.waitForStable();
  }
  return surface.observe();
}

const textOf = (o: Observation): Set<string> =>
  new Set(o.nodes.map((n) => norm(n.name)).filter((t) => t.length > 3));

export async function learnOutcomes(
  a: CapabilityArtifact,
  probes: OutcomeProbe[],
  surface: PlaywrightSurface,
  baseUrl: string,
  happyInputs: Record<string, string>,
  onProgress?: (msg: string) => void,
): Promise<OutcomeSpec[]> {
  onProgress?.(`baseline: running the happy path with ${JSON.stringify(happyInputs)}`);
  const baseline = textOf(await executeRaw(a, happyInputs, surface, baseUrl));

  const learned: OutcomeSpec[] = [];
  for (const p of probes) {
    const obs = await executeRaw(a, p.inputs, surface, baseUrl);
    const novel = [...textOf(obs)].filter((t) => !baseline.has(t));

    // Use the longest new string; short fragments could match by accident.
    const signature = novel.sort((x, y) => y.length - x.length)[0];
    if (!signature) {
      onProgress?.(`  ${p.name}: SKIPPED — produced no text the happy path does not also produce`);
      continue;
    }

    // Two outcomes with the same signature could not be told apart at replay.
    // This usually means a probe left the app in an earlier probe's state.
    if (learned.some((o) => o.detect.kind === 'textPresent' && norm(o.detect.text) === signature)) {
      onProgress?.(`  ${p.name}: SKIPPED — its signature "${signature}" was already learned for another outcome`);
      continue;
    }

    // The original-cased node, so the stored assertion reads like the app.
    const original = obs.nodes.find((n) => norm(n.name) === signature)?.name ?? signature;

    let recovery: OutcomeSpec['recovery'];
    if (p.recoverBy === 'wait') recovery = { kind: 'wait', timeoutMs: 12000 };
    else if (p.recoverBy === 'retryStep') recovery = { kind: 'retryStep', maxAttempts: 2 };
    else if (p.recoverBy === 'dismissNewControl') {
      // The new control on an interstitial is used as its dismiss target.
      const control = obs.nodes.find(
        (n) => (n.role === 'link' || n.role === 'button') && n.name !== '' && !baseline.has(norm(n.name)),
      );
      if (control) {
        const d = describeNode(obs, control, 'action');
        recovery = { kind: 'dismiss', target: d.descriptor, maxAttempts: 1 };
        onProgress?.(`  ${p.name}: recovery control discovered — ${control.role} "${control.name}"`);
      } else {
        onProgress?.(`  ${p.name}: WARNING — recoverable, but no dismiss control found`);
      }
    }

    learned.push(
      OutcomeSpecSchema.parse({
        name: p.name,
        classification: p.classification,
        detect: { kind: 'textPresent', text: original, description: `observed for inputs ${JSON.stringify(p.inputs)}` },
        message: p.message,
        ...(recovery ? { recovery } : {}),
        // A run actually produced this state.
        verified: true,
      }),
    );
    onProgress?.(`  ${p.name}: ${p.classification} <- "${original}"`);
  }
  return learned;
}
