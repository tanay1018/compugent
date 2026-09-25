import { z } from 'zod';
import { TargetDescriptor } from './target.js';
import { StateAssertion } from './assertion.js';
import { Effect } from '../policy/allowlist.js';

/**
 * The capability artifact: a contract for what can be invoked, plus the script
 * that fulfils it.
 *
 *   1. contract       inputs / outputs / outcomes      (read by the calling agent)
 *   2. script         steps / targets / checkpoint     (read by replay)
 *   3. safety         effect / idempotency probes      (read by policy and re-entry)
 *   4. re-entry map   waypoints                        (read by re-localisation)
 *
 * Steps carry waypoints because after an operator takeover the step index is
 * meaningless; replay has to work out where it is from the screen.
 */

/** Where a step's value comes from at replay time. */
export const ValueSource = z.discriminatedUnion('from', [
  z.object({ from: z.literal('param'), param: z.string() }),
  z.object({ from: z.literal('literal'), value: z.string() }),
  /**
   * Supplied by a human at run time and never stored. Used for credentials:
   * the artifact records what to ask for, and replay escalates at this step.
   */
  z.object({ from: z.literal('operator'), prompt: z.string() }),
]);
export type ValueSource = z.infer<typeof ValueSource>;

export const ParamType = z.enum(['string', 'number', 'boolean']);

export const ParamSpec = z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'camelCase'),
  type: ParamType,
  required: z.boolean().default(true),
  description: z.string(),
  example: z.string().optional(),
  /** Never logged, never written to evidence. Redaction is driven from here. */
  sensitive: z.boolean().default(false),
});
export type ParamSpec = z.infer<typeof ParamSpec>;

export const OutputSpec = z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'camelCase'),
  type: ParamType,
  description: z.string(),
  /** Where to read the value. Anchor-based, since the node's text is the value itself. */
  from: TargetDescriptor,
  /** Light normalisation so a caller gets `4182.55`, not `"$4,182.55"`. */
  transform: z.enum(['text', 'number', 'currency']).default('text'),
  sensitive: z.boolean().default(false),

  /**
   * This output must equal the named input parameter. The checkpoint only
   * proves the right screen was reached; this catches a valid detail screen
   * for the wrong record (cached page, stale session, silent default).
   */
  mustMatchParam: z.string().optional(),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

/**
 * Outcome classification lives in each artifact rather than in the replay
 * engine, because whether a state is an answer or a fault depends on the
 * capability ("not authorized" is an answer for a lookup, a fault for a batch job).
 */
export const OutcomeClass = z.enum([
  'business_outcome', // a real answer the caller must handle: "no such member"
  'recoverable',      // dismiss an interstitial, wait out a slow load, retry
  'hard_failure',     // stop and surface something debuggable
  'escalate',         // automation cannot proceed safely; route to a human
]);
export type OutcomeClass = z.infer<typeof OutcomeClass>;

export const RecoveryAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dismiss'), target: TargetDescriptor, maxAttempts: z.number().int().default(1) }),
  z.object({ kind: z.literal('wait'), timeoutMs: z.number().int().default(10000) }),
  z.object({ kind: z.literal('retryStep'), maxAttempts: z.number().int().default(2) }),
]);

export const OutcomeSpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case'),
  classification: OutcomeClass,
  /** How replay recognises this state. Evaluated against an observation. */
  detect: StateAssertion,
  /** Returned to the caller. A fixed label; must not contain run data. */
  message: z.string(),
  /** Only meaningful for `recoverable`. */
  recovery: RecoveryAction.optional(),
  /** True only once a run has actually produced this state. */
  verified: z.boolean().default(false),
});
export type OutcomeSpec = z.infer<typeof OutcomeSpec>;

export const Step = z.object({
  id: z.string(),
  index: z.number().int().positive(),
  kind: z.enum(['click', 'type', 'select', 'press', 'navigate', 'extract']),
  target: TargetDescriptor.optional(),
  value: ValueSource.optional(),

  /**
   * The state this step expects before acting. Also used by re-localisation
   * after a takeover: replay checks every waypoint to find where it is.
   */
  waypoint: StateAssertion.optional(),
  /** The state acting should produce. Verified before advancing. */
  produces: StateAssertion.optional(),

  /** Used by both policy and re-entry. */
  effect: Effect,
  /**
   * Read-only check for "has this already happened?". Required for
   * irreversible steps so resuming after a takeover does not repeat one.
   */
  idempotencyProbe: StateAssertion.optional(),

  /** The model's own justification, kept for review. */
  rationale: z.string().optional(),
  /** Set when the recorded descriptor could not be uniquely verified. */
  fragile: z.string().optional(),
});
export type Step = z.infer<typeof Step>;

export const AppBinding = z.object({
  vendorProduct: z.string(),
  /** The tenant this was recorded against; it may run on others. */
  recordedTenant: z.string(),
  surfaceKind: z.enum(['web', 'desktop']),
  /** Entry route pattern. The origin is supplied per tenant at call time. */
  entryPathPattern: z.string(),
  entryPath: z.string(),
});

export const CapabilityArtifact = z
  .object({
    schemaVersion: z.literal(1),
    /** Stable identity across versions, e.g. "member.readSavingsBalance". */
    id: z.string().regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/),
    /** Bumped whenever steps, contract or targeting change. */
    version: z.number().int().positive(),
    name: z.string(),
    /** For the calling agent: what it does and when to use it. */
    description: z.string(),

    app: AppBinding,

    inputs: z.array(ParamSpec),
    outputs: z.array(OutputSpec),
    outcomes: z.array(OutcomeSpec),

    steps: z.array(Step).min(1),
    /** Asserted before outputs are read. Optional only for incomplete artifacts. */
    checkpoint: StateAssertion.optional(),

    /**
     *   incomplete  the run never finished and has no checkpoint. Not
     *               invocable; kept so the steps that worked are not lost.
     *   draft       complete, but produced by one model run on one tenant.
     *               Attended use only.
     *   approved    reviewed. Unattended replay permitted.
     */
    approval: z.enum(['incomplete', 'draft', 'approved']).default('draft'),
    /** Why it is incomplete, phrased for whoever picks it up. */
    incompleteReason: z.string().optional(),

    provenance: z.object({
      recordedAt: z.string(),
      discoveryRunId: z.string(),
      model: z.string(),
      goal: z.string(),
      /** Carried onto the artifact so review sees them without the trace. */
      warnings: z.array(z.string()).default([]),
    }),
  })
  .superRefine((a, ctx) => {
    // Draft and approved artifacts need a checkpoint.
    if (a.approval !== 'incomplete' && !a.checkpoint) {
      ctx.addIssue({
        code: 'custom',
        message: 'a draft or approved artifact needs a checkpoint; without one replay cannot verify success',
      });
    }
    if (a.approval === 'incomplete' && !a.incompleteReason) {
      ctx.addIssue({ code: 'custom', message: 'an incomplete artifact must record why it is incomplete' });
    }
    const params = new Set(a.inputs.map((p) => p.name));
    for (const s of a.steps) {
      if (s.value?.from === 'literal' && /^(pw|pass|pin|secret|token)/i.test(s.value.value)) {
        // A basic check, not a secret detector: reject literals that look like credentials.
        ctx.addIssue({ code: 'custom', message: `step ${s.index} stores a literal that looks like a credential` });
      }
      if (s.value?.from === 'param' && !params.has(s.value.param)) {
        ctx.addIssue({ code: 'custom', message: `step ${s.index} references undeclared parameter "${s.value.param}"` });
      }
      // Irreversible steps need an idempotency probe.
      if (s.effect === 'irreversible' && !s.idempotencyProbe) {
        ctx.addIssue({
          code: 'custom',
          message: `step ${s.index} is irreversible and needs an idempotencyProbe, or re-entry after a handoff may repeat it`,
        });
      }
    }
  });

export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

/** Tool definition for a calling agent, with JSON Schema for the inputs. */
export function toToolSchema(a: CapabilityArtifact): {
  name: string; description: string; input_schema: Record<string, unknown>;
} {
  const properties: Record<string, unknown> = {};
  for (const p of a.inputs) {
    properties[p.name] = {
      type: p.type,
      description: p.description + (p.example ? ` (e.g. ${p.example})` : ''),
    };
  }
  const returns = a.outputs.map((o) => `${o.name}: ${o.type}`).join(', ');
  const others = a.outcomes.filter((o) => o.classification === 'business_outcome').map((o) => o.name);
  return {
    name: a.id.replace(/\./g, '_'),
    description:
      `${a.description}\nReturns: { ${returns} }` +
      (others.length ? `\nMay also return one of these business outcomes instead: ${others.join(', ')}.` : ''),
    input_schema: {
      type: 'object',
      properties,
      required: a.inputs.filter((p) => p.required).map((p) => p.name),
      additionalProperties: false,
    },
  };
}
