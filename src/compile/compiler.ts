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
 * Two passes:
 *
 *   generalise  one LLM call decides which literals are parameters (e.g. "12345"
 *               becomes `memberId: string`) and writes the capability's
 *               description and output types.
 *   mechanical  steps, targets, waypoints, outputs, effects and the checkpoint
 *               are derived directly from the trace. This works because the
 *               discovery tools map one-to-one onto step kinds.
 *
 * The model's proposal is validated against the trace: a parameter whose
 * literal does not appear at the step it names is dropped with a warning.
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
  /** Save a run that never finished, as an `incomplete` (non-invocable) artifact. */
  allowPartial?: boolean;
  /** Existing capabilities, so re-recording one produces a new version of it rather than a new id. */
  knownCapabilities?: { id: string; description: string }[];
}

/**
 * Remove detours from a discovery trace so replay takes the direct route.
 *
 * Steps are grouped by the location they act on. When the walk leaves a
 * location and later returns to it, everything from that location's first
 * visit onward is dropped. Consecutive steps on one screen are kept.
 *
 * Assumes re-entering a screen gives a fresh state. That holds for
 * server-rendered apps but may not for an SPA that keeps form state, so dropped
 * steps are listed in the artifact's warnings.
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
 * The state a step expects before it acts: the control it will use exists.
 *
 * Not a URL match, because legacy apps render the same screen at several URLs
 * (a form posting to itself, a post-login landing route). A URL waypoint made
 * re-localisation fail after an operator signed in at /signin and landed on
 * the lookup form.
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
  // Give a clear error instead of the schema's min(1) validation failure.
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
  // COMPILE_MODEL is separate from DISCOVERY_MODEL: this is one call, but its
  // choices are baked into every future invocation, so it can justify a
  // stronger model than the discovery loop.
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
      'Copy literalValue exactly as given. Do not invent parameters that are not literals in the trace.\n\n' +
      // Ids must be stable across re-recordings for versioning to work. Without
      // the catalogue, the same Wikipedia lookup was given four different ids.
      'IDENTITY: if the capability below is one the catalogue already contains -- the same task on ' +
      'the same surface, however differently it was worded or recorded -- reuse that id EXACTLY. ' +
      'It will be saved as a new version of it. Only mint a new id for a capability that is ' +
      'genuinely not in the list.',
    prompt:
      `GOAL AS STATED BY THE OPERATOR: ${trace.goal}\n\n` +
      (opts.knownCapabilities?.length
        ? `CAPABILITIES ALREADY IN THE CATALOGUE:\n` +
          opts.knownCapabilities.map((c) => `  ${c.id} — ${c.description}`).join('\n') + `\n\n`
        : '') +
      `RECORDED STEPS:\n${JSON.stringify(traceForModel, null, 2)}`,
  });

  // --- Validate the proposal against the trace ---------------------------
  const paramByStep = new Map<number, ParamSpec>();
  const inputs: ParamSpec[] = [];

  /**
   * Drop parameters whose value contains another parameter's value. These are
   * strings the surface composed from an input (e.g. a Wikipedia suggestion
   * "Bank of America American multinational banking..." built from
   * companyName), which a caller could not supply. The step then resolves
   * through its anchor instead.
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

    // A parameter may come from a typed value ("12345" into a field) or from
    // the step's target ("click the row for Sarah Chen").
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

    // One parameter can drive several steps; the proposal has one entry per
    // step, so de-duplicate by name.
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
    // An output that read back exactly an input's value is an echo of it;
    // replay asserts the match (mustMatchParam) to catch the wrong record.
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

  /** Replace parameter values inside a target descriptor with `{{param}}` placeholders. */
  const parameteriseTarget = (t: TargetDescriptor): TargetDescriptor => {
    let out = t;
    for (const p of inputs) {
      if (!p.example) continue;

      // Substring substitution handles values embedded in longer text (e.g.
      // "Talk:Bank of America"). Short values like "1" or "NY" would match by
      // coincidence, so only values of 4+ characters are substituted.
      const embed = (text: string): string =>
        p.example!.length >= 4 && text.includes(p.example!)
          ? text.split(p.example!).join(`{{${p.name}}}`)
          : text;

      if (out.name === p.example) {
        out = { ...out, name: `{{${p.name}}}` };
      } else if (out.name && p.example!.length >= 4 && out.name.includes(p.example!)) {
        // The name embeds the parameter inside other surface-composed text, so
        // it cannot be generalised. A `contains` match would be ambiguous (every
        // suggestion contains the company name), so the name stays pinned: it
        // misses on new values and resolution falls through to the anchor.
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

  /** Same substitution for assertions, in whichever field the variant uses. */
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
  // `type` steps aimed at non-input nodes are kept. In the weather trace such a
  // step carries the newline that submits the form, so dropping it broke replay.
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
    // Filled in later by learn-outcomes, from runs that actually produce each state.
    outcomes: [],
    steps,
    // Parameterised too, or the checkpoint would only hold for the recorded
    // input (e.g. still looking for "Bank of America" on the Microsoft page).
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

/** Exposed for tests. */
export const __testing = { pruneCycles };
