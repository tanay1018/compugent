import { generateObject } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import { CapabilityArtifact, ParamSpec, OutputSpec, type Step } from '../schema/artifact.js';
import type { TargetDescriptor } from '../schema/target.js';
import type { StateAssertion } from '../schema/assertion.js';
import { canonicaliseLocation } from '../schema/canonical.js';
import type { DiscoveryTrace, TraceStep } from '../discovery/agent.js';

/**
 * Compile a discovery trace into a capability artifact.
 *
 * Two passes, deliberately separated:
 *
 *   MECHANICAL  steps, targets, waypoints, outputs, effects and the checkpoint
 *               fall straight out of the trace, because the model's action
 *               vocabulary was constrained to what a step can express.
 *
 *   GENERALISE  one LLM call decides which run-constants are really PARAMETERS
 *               and gives the capability a contract a calling agent can read.
 *               "12345" has to become `memberId: string`, or the artifact only
 *               ever works for Sarah Chen.
 *
 * The model is in this path exactly once, offline, on a run a human is about
 * to review. Replay never calls it. That is the whole point of the artifact.
 *
 * The generalisation pass is VALIDATED, not trusted: every proposed parameter
 * must correspond to a literal that actually appears in the trace at the step
 * it claims. A hallucinated parameter is dropped and recorded as a warning
 * rather than silently written into a contract.
 */

const Proposal = z.object({
  id: z.string().describe('dotted camelCase identity, e.g. member.readSavingsBalance'),
  name: z.string(),
  description: z.string().describe('what this does and when an agent should reach for it'),
  parameters: z.array(
    z.object({
      stepIndex: z.number().int().describe('the trace step whose literal this generalises'),
      literalValue: z.string().describe('the literal exactly as it appears in that step'),
      name: z.string().describe('camelCase parameter name'),
      type: z.enum(['string', 'number', 'boolean']),
      description: z.string(),
      sensitive: z.boolean().describe('true for anything a bank must not log'),
    }),
  ).describe('literals that vary per invocation. Values that are fixed configuration must NOT appear here.'),
  outputs: z.array(
    z.object({
      name: z.string().describe('must match an extract step name from the trace'),
      type: z.enum(['string', 'number', 'boolean']),
      description: z.string(),
      transform: z.enum(['text', 'number', 'currency']),
      sensitive: z.boolean(),
    }),
  ),
});

export interface CompileOptions {
  trace: DiscoveryTrace;
  discoveryRunId: string;
  vendorProduct: string;
  tenant: string;
  model?: string;
  version?: number;
  /**
   * Save a run that never finished. Off by default: quietly turning a blocked
   * run into a capability is how an un-invocable artifact ends up in a catalog.
   */
  allowPartial?: boolean;
}

/**
 * A discovery trace is a WALK, not a route.
 *
 * The model explores: it tries a screen, finds it is a dead end, goes back and
 * takes a different turn. Recording that verbatim makes replay re-enact the
 * exploration — slower every single call, and with more chances to fail, for
 * work whose result was thrown away.
 *
 * So cycles are excised. Steps are grouped by the state they act on; when the
 * walk LEAVES a state and later returns to it, everything from that state's
 * first visit onward is dropped. Consecutive steps on one screen are not a
 * cycle — typing into a field and clicking the button beside it is ordinary
 * sequential work.
 *
 * The assumption worth stating: re-entering a screen gets it fresh. That holds
 * for server-rendered apps, which is the target here, and can fail on a SPA
 * that preserves form state across navigation. Anything dropped is therefore
 * listed in the artifact's warnings, and artifacts compile as draft.
 */
function pruneCycles(steps: TraceStep[], entryUrl: string): { kept: TraceStep[]; dropped: TraceStep[] } {
  const stateAt = (i: number): string =>
    canonicaliseLocation(i === 0 ? entryUrl : steps[i - 1]?.locationAfter ?? entryUrl).pattern;

  const kept: TraceStep[] = [];
  const dropped: TraceStep[] = [];
  const runs: Array<{ state: string; start: number }> = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const state = stateAt(i);
    const current = runs.at(-1);

    if (current && current.state === state) { kept.push(step); continue; }

    const prior = runs.findIndex((r) => r.state === state);
    if (prior >= 0) {
      dropped.push(...kept.slice(runs[prior]!.start));
      kept.length = runs[prior]!.start;
      runs.length = prior + 1;
    } else {
      runs.push({ state, start: kept.length });
    }
    kept.push(step);
  }
  return { kept, dropped };
}

/** Injected so the compiler stays free of storage concerns in tests. */
let nextVersion: (id: string) => number = () => 1;
export function setVersionResolver(fn: (id: string) => number): void { nextVersion = fn; }

export interface CompileResult {
  artifact: CapabilityArtifact;
  warnings: string[];
}

/**
 * The state a step expects BEFORE it acts.
 *
 * Deliberately node existence and NOT a URL match. Legacy apps render the same
 * screen at many different URLs — a form handler that re-renders its own form,
 * a POST target, a post-login landing route. Pinning a waypoint to the URL
 * observed during recording makes re-localisation fail on a screen that is
 * visibly correct, which is exactly what happened the first time an operator
 * signed back in at /signin and got handed the lookup form.
 *
 * What a step actually depends on is that the control it is about to use is
 * there. Location remains useful for outcome detection, where it discriminates
 * between screens rather than identifying one.
 */
function waypointFor(step: TraceStep, _locationBefore: string): StateAssertion | undefined {
  return step.target ? { kind: 'nodeExists', target: step.target } : undefined;
}

export async function compileTrace(opts: CompileOptions): Promise<CompileResult> {
  const { trace } = opts;
  const warnings = [...trace.warnings];

  const complete = trace.outcome === 'success' && trace.checkpoint !== undefined;
  if (!complete && !opts.allowPartial) {
    throw new Error(
      `refusing to compile a trace whose outcome was "${trace.outcome}"` +
      (trace.checkpoint ? '' : ' with no checkpoint') +
      `. Pass allowPartial to save it as an incomplete artifact instead — the steps that did ` +
      `work are kept, but it will not be invocable.`,
    );
  }
  // A run that gave up before acting has nothing to preserve. Saying so beats
  // letting the schema's min(1) surface as a raw validation error.
  if (trace.steps.filter((s) => s.kind !== 'extract').length === 0) {
    throw new Error(
      `nothing to compile: the run recorded no actions` +
      (trace.blockedReason ? ` (${trace.blockedReason.slice(0, 160)})` : '') +
      `. An artifact needs at least one step to be worth keeping.`,
    );
  }

  const incompleteReason = complete
    ? undefined
    : `discovery ended as "${trace.outcome}"` +
      (trace.blockedReason ? `: ${trace.blockedReason}` : '') +
      (trace.checkpoint ? '' : '; no checkpoint was established, so success cannot be verified');

  // --- Pass 1: generalise -------------------------------------------------
  /**
   * Compilation is a SINGLE call, and the judgement it makes -- which literals
   * are parameters, what the contract looks like -- is baked into every future
   * invocation. Discovery is a multi-step loop and is where the money goes. So
   * they get separate knobs: run discovery on something cheap, keep compilation
   * on something you trust. One call at premium rates is rounding error.
   */
  const modelId = opts.model ?? process.env.COMPILE_MODEL ?? process.env.DISCOVERY_MODEL ?? 'anthropic/claude-sonnet-5';
  const traceForModel = trace.steps.map((s) => ({
    index: s.index, kind: s.kind, rationale: s.rationale,
    target: s.target.name ?? s.target.anchor?.text,
    literal: s.literal, outputName: s.outputName, observedValue: s.observedValue,
  }));

  const { object: proposal } = await generateObject({
    model: gateway(modelId),
    schema: Proposal,
    system:
      'You are turning a single recorded run into a REUSABLE capability that an AI agent will call with different inputs.\n\n' +
      'The critical judgement: which literals in this run are PARAMETERS (they change per invocation, like an account ' +
      'identifier) and which are FIXED CONFIGURATION (they are part of how the capability works, like choosing which ' +
      'search mode a form uses)? Getting this wrong either pins the capability to one record, or exposes a knob no ' +
      'caller should have to think about.\n\n' +
      'Copy literalValue exactly as given. Do not invent parameters that are not literals in the trace.',
    prompt:
      `GOAL AS STATED BY THE OPERATOR: ${trace.goal}\n\n` +
      `RECORDED STEPS:\n${JSON.stringify(traceForModel, null, 2)}`,
  });

  // --- Validate the proposal against the trace ---------------------------
  const paramByStep = new Map<number, ParamSpec>();
  const inputs: ParamSpec[] = [];

  /**
   * A parameter the caller could not possibly supply is not a parameter.
   *
   * Asked to generalise a Wikipedia lookup, the model proposed `companyName`
   * ("Bank of America") and also `suggestionLabel` ("Bank of America American
   * multinational banking and financial services corporation") -- the second
   * being a string Wikipedia composed FROM the first. As a required input it
   * is unanswerable: to call the capability you would have to already know the
   * description of the article you are trying to find.
   *
   * Containment is the giveaway. One proposed value sitting inside another
   * means the surface derived it, so the longer one is dropped and its step
   * falls back to the anchor tier -- which holds the short value, and is the
   * tier that generalises anyway.
   */
  const derived = new Set(
    proposal.parameters.filter((p) =>
      proposal.parameters.some((q) =>
        q !== p && q.literalValue.length >= 4 &&
        p.literalValue.length > q.literalValue.length &&
        p.literalValue.includes(q.literalValue),
      ),
    ).map((p) => p.name),
  );

  for (const p of proposal.parameters) {
    if (derived.has(p.name)) {
      warnings.push(
        `dropped proposed parameter "${p.name}": its value is text the surface composed from ` +
        `another parameter, so no caller could supply it. The step it came from is matched by ` +
        `its anchor instead.`,
      );
      continue;
    }
    const step = trace.steps.find((s) => s.index === p.stepIndex);
    if (!step) {
      warnings.push(`dropped proposed parameter "${p.name}": no step ${p.stepIndex}`);
      continue;
    }

    // A parameter may generalise either a typed VALUE ("12345" into a field) or
    // the step's TARGET ("click the row for Sarah Chen"). Both are real; a
    // validator that only knew about values rejected genuine target parameters
    // and pinned the capability to whatever record was recorded.
    const fromValue = step.literal !== undefined && step.literal === p.literalValue;
    const fromTarget =
      step.target.name === p.literalValue || step.target.anchor?.text === p.literalValue;

    if (!fromValue && !fromTarget) {
      warnings.push(
        `dropped proposed parameter "${p.name}": ${JSON.stringify(p.literalValue)} does not appear ` +
        `at step ${p.stepIndex} as a typed value or as its target`,
      );
      continue;
    }

    // One parameter may legitimately drive several steps -- a zip code typed
    // into a search box and echoed into the result header is still ONE input.
    // The proposal carries one entry per step, so pushing blindly produced a
    // duplicate in the tool schema's `required` array and offered the caller
    // the same argument twice.
    const existing = inputs.find((i) => i.name === p.name);
    const spec = existing ?? ParamSpec.parse({
      name: p.name, type: p.type, required: true, description: p.description,
      example: p.literalValue, sensitive: p.sensitive,
    });
    if (!existing) inputs.push(spec);
    if (fromValue) paramByStep.set(p.stepIndex, spec);
  }

  // --- Pass 2: mechanical -------------------------------------------------
  const extractSteps = trace.steps.filter((s) => s.kind === 'extract');
  const outputs: OutputSpec[] = [];
  for (const s of extractSteps) {
    if (!s.outputName) continue;
    const proposed = proposal.outputs.find((o) => o.name === s.outputName);
    if (!proposed) warnings.push(`output "${s.outputName}" was recorded but not typed by the compiler; defaulting to string/text`);
    /**
     * If an output came back reading exactly what a parameter went in as, it
     * is an echo of the input, and the artifact should assert that rather than
     * merely report it. Purely mechanical -- the values either matched on the
     * recorded run or they did not, so there is nothing for a model to judge.
     */
    const echoes = inputs.find((p) => p.example !== undefined && p.example === s.observedValue);

    outputs.push(
      OutputSpec.parse({
        name: s.outputName,
        type: proposed?.type ?? 'string',
        description: proposed?.description ?? s.rationale,
        from: s.target,
        transform: proposed?.transform ?? 'text',
        sensitive: proposed?.sensitive ?? false,
        ...(echoes ? { mustMatchParam: echoes.name } : {}),
      }),
    );
    if (echoes) {
      warnings.push(
        `output "${s.outputName}" echoes the "${echoes.name}" input; replay will now assert they match`,
      );
    }
  }

  /**
   * A parameter can appear in a step's TARGET as well as its value — "click
   * the row for member 12345". Substituting it back into the descriptor is
   * what stops such a step being pinned to the record it was recorded on.
   */
  const parameteriseTarget = (t: TargetDescriptor): TargetDescriptor => {
    let out = t;
    for (const p of inputs) {
      if (!p.example) continue;

      /**
       * Whole-string equality was too strict. A surface routinely embeds the
       * value in a longer string it composed itself -- Wikipedia's checkpoint
       * anchor is "Talk:Bank of America", not "Bank of America" -- and an
       * exact match leaves that pinned to the recorded record forever.
       *
       * Substituting inside the string is only safe when the value is
       * distinctive enough that its appearance is not a coincidence. A short
       * example ("1", "NY") occurs inside unrelated text constantly, so the
       * substitution is restricted to values long enough to mean something.
       */
      const embed = (text: string): string =>
        p.example!.length >= 4 && text.includes(p.example!)
          ? text.split(p.example!).join(`{{${p.name}}}`)
          : text;

      if (out.name === p.example) {
        out = { ...out, name: `{{${p.name}}}` };
      } else if (out.name && p.example!.length >= 4 && out.name.includes(p.example!)) {
        /**
         * The parameter is embedded in a name the SURFACE composed -- Wikipedia's
         * suggestion reads "Bank of America American multinational banking and
         * financial services corporation" -- and the rest of that string is data
         * too, so the name cannot be generalised.
         *
         * Loosening it to a `contains` match on just the parameter was tried and
         * is worse: every one of the eleven suggestions contains "Bank of
         * America", so the name tier went from missing cleanly to matching
         * everything, and the step failed as ambiguous even for the value it was
         * recorded on.
         *
         * Left pinned, the name tier simply misses on a new value and resolution
         * falls through to the ANCHOR, which holds `{{companyName}}` and does
         * generalise. That fallthrough is what the tiers are for; the warning
         * tells a reviewer the name is not what is doing the work.
         */
        warnings.push(
          `step target name ${JSON.stringify(out.name)} embeds "${p.name}" in text the surface ` +
          `composed, so it stays pinned to the recorded value. This step generalises through its ` +
          `anchor instead — if it has none, re-record via a control that carries a real label.`,
        );
      }

      if (out.anchor?.text === p.example) out = { ...out, anchor: { ...out.anchor, text: `{{${p.name}}}` } };
      else if (out.anchor?.text) out = { ...out, anchor: { ...out.anchor, text: embed(out.anchor.text) } };
    }
    return out;
  };

  /**
   * An assertion carries the literal too, in whichever field its variant uses.
   */
  const parameteriseAssertion = (a: StateAssertion): StateAssertion => {
    if (a.kind === 'nodeExists' || a.kind === 'nodeAbsent') return { ...a, target: parameteriseTarget(a.target) };
    if (a.kind === 'all') return { ...a, of: a.of.map((x) => parameteriseAssertion(x) as typeof x) };
    if (a.kind === 'textPresent') {
      let text = a.text;
      for (const p of inputs) {
        if (p.example && p.example.length >= 4 && text.includes(p.example)) text = text.split(p.example).join(`{{${p.name}}}`);
      }
      return { ...a, text };
    }
    return a;
  };

  // Extraction is described by `outputs`, not replayed as an action.
  const actionSteps = trace.steps.filter((s) => s.kind !== 'extract');
  const { kept, dropped } = pruneCycles(actionSteps, trace.entryUrl);
  if (dropped.length) {
    warnings.push(
      `pruned ${dropped.length} step(s) the run backtracked out of: ` +
      dropped.map((d) => `${d.index}.${d.kind}`).join(', ') +
      ` — replay takes the direct route`,
    );
  }

  const steps: Step[] = [];
  let index = 0;
  for (const s of kept) {
    index += 1;
    const param = paramByStep.get(s.index);

    const value = s.literal === undefined
      ? undefined
      : param
        ? ({ from: 'param', param: param.name } as const)
        : ({ from: 'literal', value: s.literal } as const);

    steps.push({
      id: `s${index}`,
      index,
      kind: s.kind,
      target: parameteriseTarget(s.target),
      ...(value ? { value } : {}),
      // Built from the PARAMETERISED target: a waypoint carrying the recorded
      // literal would only ever hold for the run that recorded it.
      ...(s.target ? { waypoint: { kind: 'nodeExists' as const, target: parameteriseTarget(s.target) } } : {}),
      effect: s.effect,
      ...(s.rationale ? { rationale: s.rationale } : {}),
      ...(s.targetVerified ? {} : { fragile: s.targetProblem ?? 'descriptor could not be verified at record time' }),
    });
  }

  const entry = canonicaliseLocation(trace.entryUrl);
  const artifact = CapabilityArtifact.parse({
    schemaVersion: 1,
    id: proposal.id,
    // Re-recording an existing capability lands as the next version. The store
    // still refuses to overwrite; this just stops that being the default path.
    version: opts.version ?? nextVersion(proposal.id),
    name: proposal.name,
    description: proposal.description,
    app: {
      vendorProduct: opts.vendorProduct,
      recordedTenant: opts.tenant,
      surfaceKind: 'web',
      entryPathPattern: entry.pattern,
      entryPath: entry.path,
    },
    inputs,
    outputs,
    // Populated in Phase 5: an outcome signature is a claim about wording, and
    // wording is exactly what drifts. They are learned from runs that actually
    // produce the state, never guessed from a happy path.
    outcomes: [],
    steps,
    // The checkpoint proves the run ARRIVED, so it has to generalise with the
    // steps that get there. Left literal, a capability parameterised over
    // companies walked correctly to the Microsoft article and then declared
    // failure because the page did not mention Bank of America.
    ...(trace.checkpoint ? { checkpoint: parameteriseAssertion(trace.checkpoint) } : {}),
    approval: complete ? 'draft' : 'incomplete',
    ...(incompleteReason ? { incompleteReason } : {}),
    provenance: {
      recordedAt: trace.finishedAt,
      discoveryRunId: opts.discoveryRunId,
      model: trace.model,
      goal: trace.goal,
      warnings,
    },
  });

  return { artifact, warnings };
}

/** Exposed for tests: cycle elimination is pure and worth pinning down. */
export const __testing = { pruneCycles };
