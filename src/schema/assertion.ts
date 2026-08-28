import { z } from 'zod';
import { TargetDescriptor } from './target.js';
import type { Observation } from '../surface/types.js';
import { resolveTarget, norm } from '../surface/resolve.js';

/**
 * A condition on observable state.
 *
 * One vocabulary, four jobs — which is deliberate, and came out of watching a
 * discovery run: asked for a checkpoint, the model volunteered "the row
 * labelled Savings shows $4,182.55", i.e. it described a *state* using the
 * same anchor relation it uses to describe a *target*. Fighting that by
 * inventing a second vocabulary would have been working against the grain.
 *
 *   checkpoint        did we arrive where we intended?
 *   waypoint          is this the state this step expects? (re-localisation)
 *   idempotency probe has this irreversible step already happened?
 *   outcome signature is this a known business result rather than a failure?
 */
export const AtomicAssertion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('nodeExists'), target: TargetDescriptor, description: z.string().optional() }),
  z.object({ kind: z.literal('nodeAbsent'), target: TargetDescriptor, description: z.string().optional() }),
  z.object({
    kind: z.literal('textPresent'),
    text: z.string().min(1),
    frame: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({ kind: z.literal('locationMatches'), pattern: z.string(), description: z.string().optional() }),
]);
export type AtomicAssertion = z.infer<typeof AtomicAssertion>;

/** Conjunction is one level deep on purpose: recursive assertions would be
 *  harder to review, and no real checkpoint has needed nesting. */
export const StateAssertion = z.union([
  AtomicAssertion,
  z.object({ kind: z.literal('all'), of: z.array(AtomicAssertion).min(1), description: z.string().optional() }),
]);
export type StateAssertion = z.infer<typeof StateAssertion>;

export interface AssertionResult {
  held: boolean;
  /** Why it failed, phrased for a human debugging a production replay. */
  detail: string;
}

/**
 * Pure evaluator — same reasoning as the resolver. A checkpoint that cannot be
 * tested offline against a captured observation is a checkpoint nobody can
 * debug after the fact.
 */
export function evaluateAssertion(o: Observation, a: StateAssertion): AssertionResult {
  if (a.kind === 'all') {
    for (const sub of a.of) {
      const r = evaluateAssertion(o, sub);
      if (!r.held) return r;
    }
    return { held: true, detail: `all ${a.of.length} conditions held` };
  }
  switch (a.kind) {
    case 'nodeExists': {
      const r = resolveTarget(o, a.target);
      if (r.ok) return { held: true, detail: `found ${a.target.role}` };
      return {
        held: false,
        detail:
          r.reason === 'ambiguous'
            ? `expected one ${a.target.role}, found ${r.candidates.length}`
            : `no ${a.target.role} matching ${describeTarget(a.target)} (tried: ${r.tried.join(', ') || 'nothing'})`,
      };
    }
    case 'nodeAbsent': {
      const r = resolveTarget(o, a.target);
      return r.ok
        ? { held: false, detail: `expected ${describeTarget(a.target)} to be absent, but it is present` }
        : { held: true, detail: 'absent as expected' };
    }
    case 'textPresent': {
      const want = norm(a.text);
      const hit = o.nodes.some(
        (n) => (a.frame === undefined || n.frame === a.frame) &&
          (norm(n.name).includes(want) || norm(n.value).includes(want)),
      );
      return hit
        ? { held: true, detail: `text "${a.text}" present` }
        : { held: false, detail: `text "${a.text}" not found${a.frame ? ` in frame "${a.frame}"` : ''}` };
    }
    case 'locationMatches': {
      let re: RegExp;
      try { re = new RegExp(a.pattern); } catch { return { held: false, detail: `invalid pattern ${a.pattern}` }; }
      return re.test(o.location)
        ? { held: true, detail: `location matches ${a.pattern}` }
        : { held: false, detail: `location "${o.location}" does not match ${a.pattern}` };
    }
  }
}

export function describeTarget(t: TargetDescriptor): string {
  const bits: string[] = [t.role];
  if (t.name) bits.push(`named "${t.name}"`);
  if (t.anchor) bits.push(`${t.anchor.relation} "${t.anchor.text}"`);
  if (t.scope?.frame) bits.push(`in frame "${t.scope.frame}"`);
  if (t.ordinal !== undefined) bits.push(`#${t.ordinal}`);
  return bits.join(' ');
}
