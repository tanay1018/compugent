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
}

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

  if (trace.outcome !== 'success') {
    throw new Error(`refusing to compile a trace whose outcome was "${trace.outcome}"`);
  }
  if (!trace.checkpoint) {
    throw new Error('refusing to compile a trace with no checkpoint: replay could not verify arrival');
  }

  // --- Pass 1: generalise -------------------------------------------------
  const modelId = opts.model ?? process.env.DISCOVERY_MODEL ?? 'anthropic/claude-opus-5';
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
  for (const p of proposal.parameters) {
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

    const spec = ParamSpec.parse({
      name: p.name, type: p.type, required: true, description: p.description,
      example: p.literalValue, sensitive: p.sensitive,
    });
    inputs.push(spec);
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
      if (out.name === p.example) out = { ...out, name: `{{${p.name}}}` };
      if (out.anchor?.text === p.example) out = { ...out, anchor: { ...out.anchor, text: `{{${p.name}}}` } };
    }
    return out;
  };

  const steps: Step[] = [];
  let index = 0;
  for (const s of trace.steps) {
    if (s.kind === 'extract') continue; // extraction is described by outputs, not replayed as an action
    index += 1;
    const locationBefore = index === 1 ? trace.entryUrl : trace.steps[trace.steps.indexOf(s) - 1]?.locationAfter ?? trace.entryUrl;
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
    version: opts.version ?? 1,
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
    checkpoint: trace.checkpoint,
    approval: 'draft',
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
