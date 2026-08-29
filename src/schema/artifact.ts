import { z } from 'zod';
import { TargetDescriptor } from './target.js';
import { StateAssertion } from './assertion.js';
import { Effect } from '../policy/allowlist.js';

/**
 * THE CAPABILITY ARTIFACT.
 *
 * Not a recording of what happened — a CONTRACT for what can be invoked. The
 * distinction drives every choice below. A calling agent needs to know what
 * this capability needs, what it returns, and what can legitimately come back
 * other than success. A human reviewer needs to see what it will do to the
 * system before approving it. Neither audience is served by a step list.
 *
 * Four jobs the schema carries at once:
 *   1. an invocable contract  (inputs / outputs / outcomes)
 *   2. a deterministic script (steps / targets / checkpoint)
 *   3. a safety classification (effect / idempotency probes)
 *   4. a re-entry map        (waypoints, for resuming after a human takeover)
 *
 * Job 4 is why steps carry waypoints rather than relying on their index. After
 * an operator takes control, the step index is meaningless — the app could be
 * anywhere, including finished. The plan is a map, not a program counter.
 */

/** Where a step's value comes from at replay time. */
export const ValueSource = z.discriminatedUnion('from', [
  z.object({ from: z.literal('param'), param: z.string() }),
  z.object({ from: z.literal('literal'), value: z.string() }),
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
  /**
   * How to RE-READ this value on a page nobody has seen yet. Anchor-only by
   * construction: the text of an output node is the payload, so using it as
   * the locator would pin the artifact to the run that recorded it.
   */
  from: TargetDescriptor,
  /** Light normalisation so a caller gets `4182.55`, not `"$4,182.55"`. */
  transform: z.enum(['text', 'number', 'currency']).default('text'),
  sensitive: z.boolean().default(false),

  /**
   * This output must equal the named input parameter.
   *
   * The checkpoint proves you reached the right SCREEN; it says nothing about
   * whether the screen is about the right RECORD. A cached page, a stale
   * session, or an app that silently falls back to a default will render a
   * perfectly valid detail screen for the wrong member — every assertion
   * holds, every output extracts, and replay reports success while returning
   * somebody else's balance.
   *
   * Tying an echoed identifier back to the input closes that. In a bank it is
   * the difference between "read a balance" and "read the RIGHT person's
   * balance".
   */
  mustMatchParam: z.string().optional(),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

/**
 * The error taxonomy, IN THE SCHEMA rather than in the replay engine.
 *
 * This is the brief's most-repeated point and its named "most common design
 * mistake": "no such member" is a legitimate answer the caller needs, not a
 * crash. Putting the classification in the engine would mean every capability
 * shared one hardcoded notion of what counts as failure. Putting it here means
 * each capability declares its own, reviewably.
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
  /** Returned to the caller. Must not contain run data — it is a label. */
  message: z.string(),
  /** Only meaningful for `recoverable`. */
  recovery: RecoveryAction.optional(),
  /** False until a run has actually produced this state. An unverified
   *  outcome is a guess about wording, and wording is exactly what drifts. */
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
   * The state this step EXPECTS before acting.
   *
   * Doubles as the re-localisation key. After a human takeover, replay
   * evaluates every waypoint and asks "where am I?" — exactly one match means
   * resume there, zero means off-plan, more than one means the waypoints are
   * not discriminating enough. All three are answers; guessing is not.
   */
  waypoint: StateAssertion.optional(),
  /** The state acting should produce. Verified before advancing. */
  produces: StateAssertion.optional(),

  /** Safety class AND re-entry class — one field, two consumers. */
  effect: Effect,
  /**
   * Read-only check answering "has this already happened?".
   *
   * Required for irreversible steps, because re-entry after a takeover must
   * never blindly re-run one. If an operator already submitted the form,
   * resuming without this probe opens a second account.
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
  /** The tenant this was RECORDED against — not the only one it may run on. */
  recordedTenant: z.string(),
  surfaceKind: z.enum(['web', 'desktop']),
  /** Entry route as a pattern, with the origin supplied per tenant at call
   *  time. This is the seam that lets one artifact serve many institutions. */
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
    /** Written for the CALLING AGENT: what it does and when to reach for it. */
    description: z.string(),

    app: AppBinding,

    inputs: z.array(ParamSpec),
    outputs: z.array(OutputSpec),
    outcomes: z.array(OutcomeSpec),

    steps: z.array(Step).min(1),
    /** Proof of arrival. Asserted before outputs are read. */
    checkpoint: StateAssertion,

    /**
     * Unattended replay is gated on this. A freshly compiled artifact is a
     * draft: it has been executed exactly once, by a model, on one tenant.
     */
    approval: z.enum(['draft', 'approved']).default('draft'),

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
    const params = new Set(a.inputs.map((p) => p.name));
    for (const s of a.steps) {
      if (s.value?.from === 'param' && !params.has(s.value.param)) {
        ctx.addIssue({ code: 'custom', message: `step ${s.index} references undeclared parameter "${s.value.param}"` });
      }
      // The rule that stops a resumed run from opening a second account.
      if (s.effect === 'irreversible' && !s.idempotencyProbe) {
        ctx.addIssue({
          code: 'custom',
          message: `step ${s.index} is irreversible and needs an idempotencyProbe, or re-entry after a handoff may repeat it`,
        });
      }
    }
  });

export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

/**
 * The agent-facing view: JSON Schema for this capability's inputs.
 *
 * This is why `inputs` is a typed spec rather than a bag of strings — it drops
 * straight into a tool/function-calling surface, so a saved artifact is
 * directly invocable by an LLM agent without a hand-written wrapper.
 */
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
