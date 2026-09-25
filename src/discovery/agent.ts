import { generateText, tool, stepCountIs } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import type { TargetDescriptor } from '../schema/target.js';
import type { StateAssertion } from '../schema/assertion.js';
import { describeTarget } from '../schema/assertion.js';
import { contentLocation, type Observation, type UINode } from '../surface/types.js';
import type { PlaywrightSurface } from '../surface/playwright.js';
import {
  classifyEffect, checkAction, checkCredentialField, checkLocation, checkNavigation, isSensitiveField,
  type Effect, type PolicyConfig,
} from '../policy/allowlist.js';
import type { RunLog } from '../run/log.js';
import { describeNode } from './describe.js';
import { renderObservation } from './render.js';
import { compactObservations } from './compact.js';

/**
 * Discovery: an LLM drives the live surface until the goal is met.
 *
 * The model's tools map one-to-one onto the step kinds an artifact can hold,
 * so a successful run compiles mechanically and anything the model can do
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
  /** The literal value used on this run. The compiler may lift it to a parameter. */
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
  /** Wall-clock limit. Step count alone does not bound a run on slow pages. */
  timeoutMs?: number;
  model?: string;
  /**
   * Decides whether an irreversible action may proceed. Discovery is
   * supervised, so the default approves and records it; replay routes the same
   * decision to a human.
   */
  onApprovalRequired?: (ctx: { action: string; target: string }) => Promise<boolean>;
  /** Makes the run interruptible: an operator can take over at a step boundary and hand back. */
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
  // Default is a mid-tier model: the task is picking a node from a labelled
  // tree. `npm run models` lists cheaper options.
  const modelId = opts.model ?? process.env.DISCOVERY_MODEL ?? 'anthropic/claude-sonnet-5';
  const maxSteps = opts.maxSteps ?? 20;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const reasoningEffort = process.env.REASONING_EFFORT ?? 'low';
  const startedAt = new Date().toISOString();

  const steps: TraceStep[] = [];
  const warnings: string[] = [];
  const stepUsage: Array<{ in: number; out: number; reasoning: number; cached: number }> = [];
  /**
   * Irreversible actions already performed in this run, by target signature.
   * A ParaBank run once lost track, opened a second account and repeated a
   * transfer; repeats are now refused.
   */
  const committed = new Map<string, number>();
  let outcome: DiscoveryOutcome = 'max_steps';
  let checkpoint: StateAssertion | undefined;
  let summary: string | undefined;
  let blockedReason: string | undefined;

  // Check the allowlist before navigating.
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
   * Warn (not block) when the entry page looks inoperable: no input controls
   * and almost nothing to click, which usually means a bot wall, consent gate
   * or canvas app. Node count alone is not a signal; the target app's entry
   * screen has only 11 nodes.
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

  /**
   * Checked between steps, never mid-action.
   *
   * If a pause lands, the requested action is not performed, since the screen
   * may have changed while the operator was driving. The model is told this
   * explicitly and re-plans from a fresh observation.
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

  /**
   * Allow one action per model step.
   *
   * The SDK runs every tool call from a step back to back, but each action
   * changes the screen, so later calls target stale nodes. On weather.gov the
   * model sent click("Go") and type("10001") together and submitted an empty
   * form. Extra calls are refused with an explanation and a fresh observation.
   */
  let actedThisStep = false;

  const perform = async (
    kind: 'click' | 'type' | 'select',
    ref: number, why: string, text?: string,
  ): Promise<string> => {
    if (actedThisStep) {
      log.append('system', 'discovery.serialized', { kind, note: 'second action in one step refused' });
      obs = await surface.observe();
      return `NOT PERFORMED: one action per step.\n\n` +
             `You asked for "${kind}" alongside another action. The screen changes after every ` +
             `action, so this one was chosen against a screen that no longer exists. Nothing was ` +
             `assumed on your behalf. Here is the state after the first action -- decide again ` +
             `from what is actually there.\n\n${renderObservation(obs)}`;
    }
    actedThisStep = true;

    const interrupted = await honourBargeIn(kind);
    if (interrupted) return interrupted;
    const node = nodeByRef(ref);
    const described = describeNode(obs, node, 'action');

    const where = checkLocation(policy, obs.location);
    if (where.allow !== true) {
      const reason = (where as { reason: string }).reason;
      log.append('system', 'policy.blocked', { kind, target: describeTarget(described.descriptor), reason });
      return `BLOCKED BY POLICY: ${reason}. Go back to an allowed page, or call giveUp.`;
    }

    // Checked before acting or logging anything.
    const label = node.anchorText ?? node.name;
    const cred = checkCredentialField(policy, { kind, ...(text !== undefined ? { text } : {}) }, label, node.inputType);
    if (cred.allow === false) {
      log.append('system', 'policy.blocked', { kind, target: describeTarget(described.descriptor), reason: cred.reason });
      warnings.push(`refused to type into "${label}": credential field`);
      return `BLOCKED: ${cred.reason}\n\nIf the goal cannot continue without it, call giveUp so a human can take over.`;
    }

    const effect = classifyEffect(policy, { kind, ...(text !== undefined ? { text } : {}) }, node);

    // Has this exact irreversible action already been taken in this run?
    if (effect === 'irreversible') {
      const signature = `${kind}:${describeTarget(described.descriptor)}`;
      const previous = committed.get(signature);
      if (previous !== undefined) {
        warnings.push(`refused to repeat an irreversible action: ${signature} (already done at step ${previous})`);
        log.append('system', 'policy.blocked', {
          kind, target: describeTarget(described.descriptor),
          reason: 'irreversible action already performed in this run',
          firstPerformedAtStep: previous,
        });
        return (
          `BLOCKED: you already performed this irreversible action at step ${previous} ` +
          `(${signature}). Doing it again would duplicate its effect — a second account, a second ` +
          `transfer. If you cannot tell whether it worked, VERIFY the result on screen or call ` +
          `giveUp so a human can check. Do not redo it.`
        );
      }
      committed.set(signature, steps.length + 1);
    }

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
      // A refused credential never reaches the trace, and so never an artifact.
      ...(text !== undefined && !isSensitiveField(policy, label) && node.inputType !== 'password'
        ? { literal: text } : {}),
      effect, locationAfter: contentLocation(obs),
    };
    steps.push(step);
    log.append('agent', `act.${kind}`, {
      target: describeTarget(described.descriptor), why, effect,
      // Redact anyway, in case the field was not recognised as a credential.
      ...(text !== undefined
        ? { text: isSensitiveField(policy, label) || node.inputType === 'password' ? '[REDACTED]' : text }
        : {}),
      location: obs.location,
    }, log.saveScreenshot(await surface.screenshot(), kind));

    return `OK.\n\n${renderObservation(obs)}`;
  };

  const Ref = z.number().int().describe('a [n] ref from the most recent observation');
  const Why = z.string().describe('why this control — kept as provenance on the recorded step');

  try {
    const result = await generateText({
      model: gateway(modelId),
      // Low reasoning effort by default: reasoning tokens are billed as output
      // and resent as history each step. Providers ignore unknown options, so
      // this is safe across models.
      providerOptions: {
        anthropic: { thinking: { type: 'adaptive' }, effort: reasoningEffort },
        gateway: { reasoning: { effort: reasoningEffort } },
        openai: { reasoningEffort },
      },
      system: SYSTEM,
      prompt: `GOAL: ${opts.goal}\n\nCurrent observation:\n${renderObservation(obs)}`,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: AbortSignal.timeout(timeoutMs),
      // Replace older screens with short summaries; only the current one is needed.
      prepareStep: ({ messages }) => {
        actedThisStep = false;   // new step, new screen, one action allowed
        return { messages: compactObservations(messages) };
      },
      // Per-call token usage, so cost can be attributed to page size, history
      // or output.
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
        // Honour barge-in at every tool boundary, including extract, finish
        // and giveUp.
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
            const interrupted = await honourBargeIn('extract');
            if (interrupted) return interrupted;
            const node = nodeByRef(ref);
            // Extraction targets are anchor-only: the node's text is the value
            // being read, so it cannot also be the locator.
            const described = describeNode(obs, node, 'extraction');
            const value = node.name || node.value;
            if (!described.verified) {
              warnings.push(`output "${as}": ${described.problem}`);
              log.append('system', 'descriptor.unverified', { output: as, problem: described.problem });
              return `WARNING: "${as}" cannot be relocated on a fresh page (${described.problem}). ` +
                     `Pick a node that sits next to a stable label instead.`;
            }
            // Reject anchors that look like data (numbers, currency, dates).
            // E.g. anchoring `wins` to "1990" only resolves for that one row.
            const anchorText = described.descriptor.anchor?.text ?? '';
            const looksLikeData =
              anchorText !== '' &&
              (/^[^A-Za-z]*$/.test(anchorText) ||
               /^[$£€]?[\d,.]+%?$/.test(anchorText.trim()) ||
               anchorText.trim() === String(value).trim());
            if (looksLikeData) {
              warnings.push(
                `output "${as}" is anchored to "${anchorText}", which looks like this run's data ` +
                `rather than a stable label — it will not resolve for other inputs`,
              );
              log.append('system', 'descriptor.unverified', {
                output: as, problem: `anchor "${anchorText}" looks like run data, not a label`,
              });
            }

            steps.push({
              index: steps.length + 1, kind: 'extract', rationale: why,
              target: described.descriptor, targetVerified: true,
              ...(looksLikeData ? { targetProblem: `anchored to "${anchorText}", which looks like run data` } : {}),
              outputName: as, observedValue: value, effect: 'read', locationAfter: contentLocation(obs),
            });
            log.append('agent', 'act.extract', { as, target: describeTarget(described.descriptor), why });
            if (looksLikeData) {
              return `Recorded "${as}", but it is anchored to ${JSON.stringify(anchorText)} — that is a VALUE ` +
                `from this run, not a label, so it will not be found for other inputs. Re-extract it anchored ` +
                `to a column header or field label if one exists.`;
            }
            return `Recorded output "${as}" = ${JSON.stringify(value)}, located by ${describeTarget(described.descriptor)}.`;
          },
        }),
        finish: tool({
          description: 'The goal is met. Nominate a node proving you reached the right screen.',
          inputSchema: z.object({
            checkpointRef: Ref.describe(
              'a node whose presence proves arrival. It must be something that will be there ' +
              'for EVERY value this capability is later run with, not just the one you used. ' +
              'Page furniture that happens to be present today is the wrong choice: a warning ' +
              'banner, a promotion, a "discuss this issue" notice or anything conditional on ' +
              'this particular record will be missing on the next one and the run will report ' +
              'failure on a screen that is perfectly correct. Prefer the heading, the title, or ' +
              'a label that is part of the page template itself.',
            ),
            summary: z.string(),
          }),
          execute: async ({ checkpointRef, summary: s }) => {
            const interrupted = await honourBargeIn('finish');
            if (interrupted) return interrupted;
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
            // The run is ending; yield now rather than waiting for a step boundary.
            if (opts.session) opts.session.agentActive = false;
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
    // An abort means the timeout fired; keep the partial trace.
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
