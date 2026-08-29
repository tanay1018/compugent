import { generateText, tool, stepCountIs } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import type { TargetDescriptor } from '../schema/target.js';
import type { StateAssertion } from '../schema/assertion.js';
import { describeTarget } from '../schema/assertion.js';
import { contentLocation, type Observation, type UINode } from '../surface/types.js';
import type { PlaywrightSurface } from '../surface/playwright.js';
import {
  classifyEffect, checkAction, checkCredentialField, checkNavigation, isSensitiveField,
  type Effect, type PolicyConfig,
} from '../policy/allowlist.js';
import type { RunLog } from '../run/log.js';
import { describeNode } from './describe.js';
import { renderObservation } from './render.js';
import { compactObservations } from './compact.js';

/**
 * Discovery: an LLM drives the live surface until the goal is met.
 *
 * The model's action space is EXACTLY the vocabulary a recorded step can
 * express. That is the central constraint of this file — it means a successful
 * run compiles into an artifact mechanically, instead of requiring someone to
 * reverse-engineer intent out of a chat transcript. Anything the model can do
 * here, replay can do without it.
 */

export type DiscoveryOutcome = 'success' | 'gave_up' | 'max_steps' | 'timeout' | 'blocked' | 'error';

export interface TraceStep {
  index: number;
  kind: 'click' | 'type' | 'select' | 'extract';
  rationale: string;
  target: TargetDescriptor;
  targetVerified: boolean;
  targetProblem?: string;
  /** The literal value used on THIS run. Phase 4 lifts these to typed params. */
  literal?: string;
  outputName?: string;
  observedValue?: string;
  effect: Effect;
  locationAfter: string;
}

export interface DiscoveryTrace {
  goal: string;
  entryUrl: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  outcome: DiscoveryOutcome;
  steps: TraceStep[];
  checkpoint?: StateAssertion;
  summary?: string;
  blockedReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Per model call, so a climbing input count can be attributed. */
  stepUsage?: Array<{ in: number; out: number; reasoning: number; cached: number }>;
  warnings: string[];
}

export interface DiscoveryOptions {
  goal: string;
  entryUrl: string;
  surface: PlaywrightSurface;
  policy: PolicyConfig;
  log: RunLog;
  maxSteps?: number;
  /**
   * Wall-clock ceiling. Step count alone does not bound a run: a single step
   * can sit on a slow page for a long time, and an eight-second stall repeated
   * across twenty steps is minutes of paid-for waiting with nothing to show.
   */
  timeoutMs?: number;
  model?: string;
  /**
   * Seam for Phase 6. Discovery is a supervised activity, so the default
   * auto-approves an irreversible action and records that it did. In replay
   * the same decision routes to a human instead.
   */
  onApprovalRequired?: (ctx: { action: string; target: string }) => Promise<boolean>;
  /**
   * When present, the run is watchable and interruptible: an operator can
   * barge in from the console at any step boundary, drive the session
   * themselves, and hand back.
   */
  session?: {
    control: { pauseRequested: boolean; state: string; canAgentAct: boolean };
    agentActive: boolean;
    yield(): void;
    awaitAgentControl(): Promise<void>;
    resumeDiscovery(): void;
  };
}

const SYSTEM = `You operate a legacy bank back-office application through its accessibility tree.

You never see HTML and there are no CSS selectors. You act only on node refs.

Reading an observation:
  [n] role "name"                       a control with an accessible name
  [n] role anchored-to="X" (relation)   the control has NO accessible name of
                                        its own. This is a table-layout legacy
                                        screen, so its identity is the text
                                        beside it. Trust that text.
  [n] role "name" anchored-to="X" (..)  both are known; both get recorded.

You are not just completing a task — you are RECORDING A REUSABLE CAPABILITY
that will be replayed later, with different inputs, without you. So:

  - Explain each choice in "why". That reasoning is kept as provenance.
  - Use extract() for every value that is part of the answer. Do not simply
    read a number and report it in your summary: replay has to be able to find
    that value again on a page it has never seen, and extract() is what records
    how.
  - Finish by nominating a node whose presence proves you reached the right
    screen. Prefer a stable label over a value that changes between runs.

Work one step at a time. After each action you receive a fresh observation.`;

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryTrace> {
  const { surface, policy, log } = opts;
  /**
   * Discovery is the multi-step loop, so this is where the money goes. The
   * default is deliberately not the most capable model available: the task is
   * "read a normalised tree, pick a node, call a tool", and a premium
   * reasoning model spends most of its budget deliberating over a choice
   * between a dozen labelled controls. `npm run models` lists cheaper options
   * -- deepseek-v4-flash lands near $0.003 a run against $0.130 for opus.
   */
  const modelId = opts.model ?? process.env.DISCOVERY_MODEL ?? 'anthropic/claude-sonnet-5';
  const maxSteps = opts.maxSteps ?? 20;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const reasoningEffort = process.env.REASONING_EFFORT ?? 'low';
  const startedAt = new Date().toISOString();

  const steps: TraceStep[] = [];
  const warnings: string[] = [];
  const stepUsage: Array<{ in: number; out: number; reasoning: number; cached: number }> = [];
  let outcome: DiscoveryOutcome = 'max_steps';
  let checkpoint: StateAssertion | undefined;
  let summary: string | undefined;
  let blockedReason: string | undefined;

  // Allowlist is enforced before the browser ever moves, not after.
  const nav = checkNavigation(policy, opts.entryUrl);
  if (nav.allow !== true) {
    log.append('system', 'policy.blocked', { url: opts.entryUrl, reason: (nav as { reason: string }).reason });
    return {
      goal: opts.goal, entryUrl: opts.entryUrl, model: modelId, startedAt,
      finishedAt: new Date().toISOString(), outcome: 'blocked',
      blockedReason: (nav as { reason: string }).reason, steps: [], warnings,
    };
  }

  log.append('system', 'discovery.start', {
    goal: opts.goal, entryUrl: opts.entryUrl, model: modelId, maxSteps,
    reasoningEffort, timeoutMs,
  });
  if (opts.session) opts.session.agentActive = true;
  await surface.navigate(opts.entryUrl);
  await surface.waitForStable();
  let obs: Observation = await surface.observe();
  log.append('agent', 'observe', { location: obs.location, nodes: obs.nodes.length },
    log.saveScreenshot(await surface.screenshot(), 'entry'));

  /**
   * Is there anything here to operate?
   *
   * Node count alone is a bad signal — the bundled legacy app's entry screen is
   * a perfectly workable 11 nodes, and flagging it was the first thing this
   * check got wrong. What actually distinguishes a bot wall, a consent gate or
   * a canvas app is that there is nowhere to put input and almost nothing to
   * click. Amazon's interstitial is one button and two footer links; a real
   * form screen has a field.
   *
   * Heuristic, and labelled as one: it warns, it does not block.
   */
  {
    const inputs = obs.nodes.filter((n) => n.role === 'textbox' || n.role === 'combobox');
    const clickable = obs.nodes.filter((n) => n.role === 'button' || n.role === 'link');
    if (inputs.length === 0 && clickable.length <= 3 && obs.nodes.length < 15) {
      const warning =
        `the entry page has no input controls and only ${clickable.length} clickable element(s) ` +
        `across ${obs.nodes.length} nodes — usually a bot wall, a consent gate, or a ` +
        `canvas-rendered app with no accessibility tree`;
      warnings.push(warning);
      log.append('system', 'surface.thin', {
        nodes: obs.nodes.length, inputs: inputs.length, clickable: clickable.length,
        location: obs.location,
        sample: obs.nodes.map((n) => n.name).filter(Boolean).slice(0, 6),
        note: warning,
      });
    }
  }

  const nodeByRef = (ref: number): UINode => {
    const n = obs.nodes.find((x) => x.ref === ref);
    if (!n) throw new Error(`ref ${ref} is not in the current observation`);
    return n;
  };

  /** Shared path for every acting tool: describe -> gate -> act -> re-observe. */
  /**
   * Checked between steps, never mid-action.
   *
   * When a pause lands, the action the model just asked for is NOT performed —
   * the world may have changed underneath it while the human was driving, so
   * re-planning against what is actually on screen is the only safe move. The
   * message says so explicitly: leaving the model to infer whether its call
   * took effect is how a run starts flailing.
   */
  const honourBargeIn = async (kind: string): Promise<string | null> => {
    const sess = opts.session;
    if (!sess) return null;
    if (!sess.control.pauseRequested && sess.control.canAgentAct) return null;

    if (sess.control.pauseRequested) {
      sess.yield();
      log.append('system', 'discovery.paused', { note: 'operator took control at a step boundary' });
    }
    await sess.awaitAgentControl();
    obs = await surface.observe();
    log.append('system', 'discovery.resumed', { location: obs.location });
    return `INTERRUPTED. A human operator took control of this session and has now handed it back.\n\n` +
           `Your requested "${kind}" was NOT performed — the operator may have changed the screen, ` +
           `so nothing was assumed on your behalf. Re-read the state below and decide what to do next. ` +
           `The work the operator did may have already advanced the goal.\n\n${renderObservation(obs)}`;
  };

  const perform = async (
    kind: 'click' | 'type' | 'select',
    ref: number, why: string, text?: string,
  ): Promise<string> => {
    const interrupted = await honourBargeIn(kind);
    if (interrupted) return interrupted;
    const node = nodeByRef(ref);
    const described = describeNode(obs, node, 'action');

    // Checked before anything is done or written down. A credential that
    // reaches the log has already been typed into a live system.
    const label = node.anchorText ?? node.name;
    const cred = checkCredentialField(policy, { kind, ...(text !== undefined ? { text } : {}) }, label);
    if (cred.allow === false) {
      log.append('system', 'policy.blocked', { kind, target: describeTarget(described.descriptor), reason: cred.reason });
      warnings.push(`refused to type into "${label}": credential field`);
      return `BLOCKED: ${cred.reason}\n\nIf the goal cannot continue without it, call giveUp so a human can take over.`;
    }

    const effect = classifyEffect(policy, { kind, ...(text !== undefined ? { text } : {}) }, node);

    const decision = checkAction(policy, { kind, ...(text !== undefined ? { text } : {}) }, effect);
    if (decision.allow === false) {
      log.append('system', 'policy.blocked', { kind, target: describeTarget(described.descriptor), reason: decision.reason });
      return `BLOCKED BY POLICY: ${decision.reason}. Choose a different approach.`;
    }
    if (decision.allow === 'needs_approval') {
      const approve = opts.onApprovalRequired ?? (async () => true);
      const ok = await approve({ action: kind, target: describeTarget(described.descriptor) });
      log.append('system', ok ? 'policy.approved' : 'policy.denied', {
        kind, effect, target: describeTarget(described.descriptor),
        note: opts.onApprovalRequired ? 'operator decision' : 'auto-approved: discovery is supervised',
      });
      if (!ok) return `DENIED: an operator declined this irreversible action.`;
    }

    if (!described.verified) {
      warnings.push(`step ${steps.length + 1} (${kind}): ${described.problem}`);
      log.append('system', 'descriptor.unverified', { kind, problem: described.problem });
    } else if (described.problem) {
      warnings.push(`step ${steps.length + 1} (${kind}): ${described.problem}`);
    }

    await surface.act(obs, node, { kind, ...(text !== undefined ? { text } : {}) });
    await surface.waitForStable();
    obs = await surface.observe();

    const step: TraceStep = {
      index: steps.length + 1, kind, rationale: why,
      target: described.descriptor, targetVerified: described.verified,
      ...(described.problem ? { targetProblem: described.problem } : {}),
      // A refused credential never reaches the trace, so it can never reach an
      // artifact -- which is a file that gets committed, diffed and shared.
      ...(text !== undefined && !isSensitiveField(policy, label) ? { literal: text } : {}),
      effect, locationAfter: contentLocation(obs),
    };
    steps.push(step);
    log.append('agent', `act.${kind}`, {
      target: describeTarget(described.descriptor), why, effect,
      // Belt and braces: the field was already refused above if it read as a
      // credential, but the log never takes a value on trust.
      ...(text !== undefined ? { text: isSensitiveField(policy, label) ? '[REDACTED]' : text } : {}),
      location: obs.location,
    }, log.saveScreenshot(await surface.screenshot(), kind));

    return `OK.\n\n${renderObservation(obs)}`;
  };

  const Ref = z.number().int().describe('a [n] ref from the most recent observation');
  const Why = z.string().describe('why this control — kept as provenance on the recorded step');

  try {
    const result = await generateText({
      model: gateway(modelId),
      /**
       * Reasoning depth. Choosing which of a dozen labelled controls to click
       * is not a task that rewards extended thinking, and every thinking token
       * is billed on output AND resent as history on the next step. Opus-class
       * models think adaptively by default, which is how a five-step run ends
       * up spending more on deliberation than on decisions.
       *
       * Provider options are advisory: an unrecognised key is ignored rather
       * than fatal, so this is safe across the gateway's model catalogue.
       */
      providerOptions: {
        anthropic: { thinking: { type: 'adaptive' }, effort: reasoningEffort },
        gateway: { reasoning: { effort: reasoningEffort } },
        openai: { reasoningEffort },
      },
      system: SYSTEM,
      prompt: `GOAL: ${opts.goal}\n\nCurrent observation:\n${renderObservation(obs)}`,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: AbortSignal.timeout(timeoutMs),
      // Only the current screen is decidable-on; older ones are dead weight
      // that the loop would otherwise pay to resend on every step.
      prepareStep: ({ messages }) => ({ messages: compactObservations(messages) }),
      /**
       * Per-step token accounting. Without this, a run reports one aggregate
       * number and there is no way to tell a big page from a long history from
       * a chatty model -- which is exactly the confusion a climbing input count
       * in the provider's dashboard produces.
       */
      onStepFinish: ({ usage }) => {
        const u = usage as { inputTokens?: number; outputTokens?: number; reasoningTokens?: number;
                             cachedInputTokens?: number } | undefined;
        stepUsage.push({
          in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0,
          reasoning: u?.reasoningTokens ?? 0, cached: u?.cachedInputTokens ?? 0,
        });
        log.append('system', 'model.step', stepUsage[stepUsage.length - 1] as unknown as Record<string, unknown>);
      },
      tools: {
        click: tool({
          description: 'Click a control.',
          inputSchema: z.object({ ref: Ref, why: Why }),
          execute: ({ ref, why }) => perform('click', ref, why),
        }),
        type: tool({
          description: 'Focus a text field and type into it, replacing any existing value.',
          inputSchema: z.object({ ref: Ref, text: z.string(), why: Why }),
          execute: ({ ref, text, why }) => perform('type', ref, why, text),
        }),
        select: tool({
          description: 'Choose an option in a combobox by its visible text or value.',
          inputSchema: z.object({ ref: Ref, value: z.string(), why: Why }),
          execute: ({ ref, value, why }) => perform('select', ref, why, value),
        }),
        extract: tool({
          description:
            'Record that a value on screen is part of the answer. Use this for every output — ' +
            'it records HOW to find the value again, not just what it says today.',
          inputSchema: z.object({
            ref: Ref,
            as: z.string().describe('output name in camelCase, e.g. savingsBalance'),
            why: Why,
          }),
          execute: async ({ ref, as, why }) => {
            const node = nodeByRef(ref);
            // Extraction targets are anchor-only: the node's text IS the data,
            // so using it as the identity would pin the artifact to one member.
            const described = describeNode(obs, node, 'extraction');
            const value = node.name || node.value;
            if (!described.verified) {
              warnings.push(`output "${as}": ${described.problem}`);
              log.append('system', 'descriptor.unverified', { output: as, problem: described.problem });
              return `WARNING: "${as}" cannot be relocated on a fresh page (${described.problem}). ` +
                     `Pick a node that sits next to a stable label instead.`;
            }
            steps.push({
              index: steps.length + 1, kind: 'extract', rationale: why,
              target: described.descriptor, targetVerified: true,
              outputName: as, observedValue: value, effect: 'read', locationAfter: contentLocation(obs),
            });
            log.append('agent', 'act.extract', { as, target: describeTarget(described.descriptor), why });
            return `Recorded output "${as}" = ${JSON.stringify(value)}, located by ${describeTarget(described.descriptor)}.`;
          },
        }),
        finish: tool({
          description: 'The goal is met. Nominate a node proving you reached the right screen.',
          inputSchema: z.object({
            checkpointRef: Ref.describe('a node whose presence proves arrival — prefer a stable label over a changing value'),
            summary: z.string(),
          }),
          execute: async ({ checkpointRef, summary: s }) => {
            const node = nodeByRef(checkpointRef);
            const described = describeNode(obs, node, node.name ? 'action' : 'extraction');
            checkpoint = { kind: 'nodeExists', target: described.descriptor, description: s };
            summary = s;
            outcome = 'success';
            log.append('agent', 'finish', { checkpoint: describeTarget(described.descriptor), summary: s });
            return 'Recorded. Stop now.';
          },
        }),
        giveUp: tool({
          description: 'Report that you cannot safely proceed. This routes to a human operator.',
          inputSchema: z.object({ reason: z.string(), blocking: z.string() }),
          execute: async ({ reason, blocking }) => {
            outcome = 'gave_up';
            blockedReason = `${reason} — blocked on: ${blocking}`;
            log.append('agent', 'escalate', { reason, blocking },
              log.saveScreenshot(await surface.screenshot(), 'stuck'));
            return 'Escalation recorded. Stop now.';
          },
        }),
      },
    });

    const u = (result as { totalUsage?: { inputTokens?: number; outputTokens?: number }; usage?: { inputTokens?: number; outputTokens?: number } });
    const usage = u.totalUsage ?? u.usage;

    const trace: DiscoveryTrace = {
      goal: opts.goal, entryUrl: opts.entryUrl, model: modelId, startedAt,
      finishedAt: new Date().toISOString(), outcome, steps, warnings,
      ...(checkpoint ? { checkpoint } : {}),
      ...(summary ? { summary } : {}),
      ...(blockedReason ? { blockedReason } : {}),
      ...(usage ? { usage } : {}),
      ...(stepUsage.length ? { stepUsage } : {}),
    };
    log.append('system', 'discovery.end', { outcome, steps: steps.length, warnings: warnings.length });
    if (opts.session) opts.session.agentActive = false;
    return trace;
  } catch (err) {
    if (opts.session) opts.session.agentActive = false;
    // An abort is the timeout firing, not a fault: whatever the run achieved
    // up to that point is still worth keeping and inspecting.
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /abort/i.test(err.message));
    log.append('system', timedOut ? 'discovery.timeout' : 'discovery.error',
      { message: String(err), afterMs: Date.now() - Date.parse(startedAt), steps: steps.length });
    return {
      goal: opts.goal, entryUrl: opts.entryUrl, model: modelId, startedAt,
      finishedAt: new Date().toISOString(),
      outcome: timedOut ? 'timeout' : 'error',
      blockedReason: timedOut ? `gave up after ${Math.round(timeoutMs / 1000)}s` : String(err),
      steps, warnings,
    };
  }
}
