import type { CapabilityArtifact, OutcomeSpec, Step } from '../schema/artifact.js';
import { evaluateAssertion, describeTarget, type StateAssertion } from '../schema/assertion.js';
import type { Observation } from '../surface/types.js';
import type { PlaywrightSurface } from '../surface/playwright.js';
import { checkAction, type PolicyConfig } from '../policy/allowlist.js';
import { interpolate, norm } from '../surface/resolve.js';
import type { RunLog } from '../run/log.js';
import type { ReplayResult, StepReport, ReplayFailure } from './result.js';

/**
 * Deterministic replay — the production execution path.
 *
 * NO MODEL IS INVOKED HERE. This file imports nothing from `ai` or the gateway,
 * and a test asserts that stays true. Everything the model figured out during
 * discovery is already in the artifact; re-deriving it per call would be slow,
 * expensive and non-deterministic, which is the entire reason the artifact
 * exists.
 *
 * The interesting part is not executing steps — it is deciding what a
 * departure from the happy path MEANS. Replay never treats an unexpected
 * screen as a generic failure until it has asked whether the artifact declares
 * that screen as a known outcome.
 */

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, string | number | boolean>;
  surface: PlaywrightSurface;
  policy: PolicyConfig;
  log: RunLog;
  /** Tenant origin. The artifact stores a route pattern, not a host, so one
   *  capability can serve many institutions on the same vendor product. */
  baseUrl: string;
  /** Unattended callers may not run a draft artifact. */
  unattended?: boolean;
  stepTimeoutMs?: number;
  /**
   * Resume an interrupted run at this step, rather than starting over.
   * Supplied by re-localisation after a human handed control back — never
   * chosen by the caller, because only observed state can say where we are.
   */
  resumeFrom?: number;
  /** The session is already positioned; do not navigate and lose its state. */
  skipNavigation?: boolean;
}

interface Matched {
  outcome: OutcomeSpec;
  detail: string;
}

/** Ask the artifact what this screen means, before calling it a failure. */
function matchOutcome(a: CapabilityArtifact, o: Observation, params?: Record<string, unknown>): Matched | null {
  for (const oc of a.outcomes) {
    const r = evaluateAssertion(o, oc.detect, params);
    if (r.held) return { outcome: oc, detail: r.detail };
  }
  return null;
}

function bindValue(step: Step, inputs: Record<string, unknown>): string | undefined {
  if (!step.value) return undefined;
  return step.value.from === 'literal' ? step.value.value : String(inputs[step.value.param] ?? '');
}

function applyTransform(raw: string, transform: 'text' | 'number' | 'currency'): unknown {
  if (transform === 'text') return raw;
  const n = Number(raw.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : raw;
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const { artifact: a, surface, policy, log } = opts;
  const runId = log.dir.split('/').at(-1)!;
  const t0 = Date.now();
  const steps: StepReport[] = [];
  const stepTimeout = opts.stepTimeoutMs ?? 15000;

  /**
   * The CALLER gets real values; the LOG and the evidence file get redacted
   * ones. Those are different audiences and conflating them is how regulated
   * data ends up on disk: the agent needs the balance to act on it, the
   * evidence directory has no business retaining it.
   */
  const redactOutputs = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [k, a.outputs.find((s) => s.name === k)?.sensitive ? '[REDACTED]' : v]),
    );

  const done = (r: Omit<ReplayResult, 'runId' | 'ms' | 'steps'>): ReplayResult => {
    const out = { ...r, runId, steps, ms: Date.now() - t0 } as ReplayResult;
    const persistable =
      out.status === 'success' ? { ...out, outputs: redactOutputs(out.outputs) } : out;
    log.append('system', `replay.${out.status}`, { ...persistable, steps: undefined });
    log.writeJson('result.json', persistable);
    return out;
  };

  const fail = async (f: Omit<ReplayFailure, 'screenshot'>): Promise<ReplayResult> => {
    const shot = log.saveScreenshot(await surface.screenshot(), 'failure');
    return done({ status: 'failed', failure: { ...f, screenshot: shot } } as never);
  };

  log.append('system', 'replay.start', {
    capability: `${a.id} v${a.version}`, approval: a.approval,
    inputs: Object.fromEntries(
      Object.entries(opts.inputs).map(([k, v]) => [k, a.inputs.find((p) => p.name === k)?.sensitive ? '[REDACTED]' : v]),
    ),
  });

  // --- Contract enforcement, before anything moves ------------------------
  for (const p of a.inputs) {
    const v = opts.inputs[p.name];
    if (v === undefined) {
      if (p.required) return fail({ code: 'input_invalid', expected: `required input "${p.name}"`, observed: 'not supplied' });
      continue;
    }
    if (p.type === 'number' && Number.isNaN(Number(v))) {
      return fail({ code: 'input_invalid', expected: `"${p.name}" to be a number`, observed: JSON.stringify(v) });
    }
  }
  if (opts.unattended && a.approval !== 'approved') {
    return fail({
      code: 'not_approved',
      expected: 'an approved artifact for unattended replay',
      observed: `${a.id} v${a.version} is still a draft`,
    });
  }

  if (opts.skipNavigation) {
    log.append('system', 'replay.resume', { fromStep: opts.resumeFrom ?? 1, note: 'continuing in the existing session' });
  } else {
    await surface.navigate(opts.baseUrl);
    await surface.waitForStable();
    log.append('agent', 'navigate', { url: opts.baseUrl });
  }

  // --- Steps --------------------------------------------------------------
  for (const step of a.steps) {
    if (opts.resumeFrom !== undefined && step.index < opts.resumeFrom) {
      steps.push({ index: step.index, id: step.id, kind: step.kind, status: 'skipped', ms: 0,
                   note: 'completed before the handoff' });
      continue;
    }
    const sT0 = Date.now();
    const report: StepReport = { index: step.index, id: step.id, kind: step.kind, status: 'ok', ms: 0 };
    if (step.target) report.target = describeTarget(step.target);

    let attempts = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempts += 1;

      // 1. Wait for the state this step expects. Waiting IS the recovery for
      //    transient slowness -- no separate retry policy needed for a slow load.
      //
      //    The wait also aborts the moment the artifact RECOGNISES the screen.
      //    Without that, a "no such member" lookup would sit through the full
      //    step timeout before reporting an answer the app rendered instantly.
      const settled: Observation | null = step.waypoint
        ? await surface.waitUntil(
            (o) => evaluateAssertion(o, step.waypoint as StateAssertion, opts.inputs).held || matchOutcome(a, o, opts.inputs) !== null,
            { timeoutMs: stepTimeout },
          )
        : await surface.observe();

      const obs: Observation | null =
        settled && (!step.waypoint || evaluateAssertion(settled, step.waypoint, opts.inputs).held) ? settled : null;

      if (!obs) {
        // Did not arrive. Ask the artifact what this screen means BEFORE
        // calling it a failure -- this is where "no such member" is separated
        // from "the app is broken".
        const current = settled ?? (await surface.observe());
        const m = matchOutcome(a, current, opts.inputs);
        if (m) {
          const handled = await handleOutcome(m, current);
          if (handled === 'retry' && attempts <= 3) continue;
          if (handled !== 'retry') return handled;
        }
        report.status = 'failed';
        report.ms = Date.now() - sT0;
        steps.push(report);
        const detail = evaluateAssertion(current, step.waypoint as StateAssertion, opts.inputs);
        return fail({
          code: 'waypoint_failed', stepIndex: step.index, stepId: step.id,
          expected: describeAssertion(step.waypoint as StateAssertion, opts.inputs),
          observed: `${detail.detail} (at ${current.location})`,
        });
      }

      // An outcome can also be reached WHILE the waypoint holds -- a permission
      // banner rendered on the same screen, for instance.
      const early = matchOutcome(a, obs, opts.inputs);
      if (early) {
        const handled = await handleOutcome(early, obs);
        if (handled === 'retry' && attempts <= 3) continue;
        if (handled !== 'retry') return handled;
      }

      if (!step.target) break;

      // 2. Resolve.
      const r = surface.resolve(obs, step.target, opts.inputs);
      if (!r.ok) {
        report.status = 'failed';
        report.ms = Date.now() - sT0;
        steps.push(report);
        return fail(
          r.reason === 'ambiguous'
            ? {
                code: 'target_ambiguous', stepIndex: step.index, stepId: step.id,
                expected: `exactly one ${describeTarget(step.target)}`,
                observed: `${r.candidates.length} candidates: ` +
                  r.candidates.map((c) => `${c.role}"${c.name || c.anchorText || '?'}"`).join(', '),
              }
            : {
                code: 'target_not_found', stepIndex: step.index, stepId: step.id,
                expected: describeTarget(step.target),
                observed: `not present at ${obs.location} (tried: ${r.tried.join(', ') || 'nothing'})`,
              },
        );
      }
      report.resolvedVia = r.via;

      // 3. Policy. The artifact declares the effect; policy only enforces it.
      const value = bindValue(step, opts.inputs);
      const action = { kind: step.kind as never, ...(value !== undefined ? { text: value } : {}) };
      const decision = checkAction(policy, action, step.effect);
      if (decision.allow === false) {
        report.status = 'failed';
        steps.push(report);
        return fail({
          code: 'policy_blocked', stepIndex: step.index, stepId: step.id,
          expected: 'an action permitted by policy', observed: decision.reason,
        });
      }
      if (decision.allow === 'needs_approval') {
        // 4. Irreversible: has it already happened? Without this, a run resumed
        //    after a human takeover opens a second account.
        if (step.idempotencyProbe && evaluateAssertion(obs, step.idempotencyProbe, opts.inputs).held) {
          report.status = 'skipped';
          report.note = 'idempotency probe indicates this step already took effect';
          report.ms = Date.now() - sT0;
          steps.push(report);
          log.append('system', 'step.skipped', { step: step.index, reason: report.note });
          break;
        }
        report.ms = Date.now() - sT0;
        steps.push(report);
        const shot = log.saveScreenshot(await surface.screenshot(), 'approval');
        return done({
          status: 'escalated', reason: decision.reason, atStep: step.index,
          context: { location: obs.location, screenshot: shot, expected: describeTarget(step.target) },
        } as never);
      }

      // 5. Act.
      await surface.act(obs, r.node, action);
      await surface.waitForStable();
      log.append('agent', `step.${step.kind}`, {
        step: step.index, target: describeTarget(step.target), via: r.via,
        ...(value !== undefined
          ? { value: a.inputs.find((p) => p.name === (step.value?.from === 'param' ? step.value.param : ''))?.sensitive ? '[REDACTED]' : value }
          : {}),
      });

      if (step.produces) {
        const after = await surface.waitUntil((o) => evaluateAssertion(o, step.produces as StateAssertion, opts.inputs).held, { timeoutMs: stepTimeout });
        if (!after) {
          const current = await surface.observe();
          const m = matchOutcome(a, current, opts.inputs);
          if (m) {
            const handled = await handleOutcome(m, current);
            if (handled !== 'retry') return handled;
          }
        }
      }
      break;
    }

    report.ms = Date.now() - sT0;
    if (report.status === 'ok' || report.status === 'recovered') steps.push(report);
    else if (!steps.includes(report)) steps.push(report);
  }

  // --- Checkpoint ---------------------------------------------------------
  //
  // Checkpoint verification is a LOOP, not a single check. A recoverable
  // outcome between the last step and the checkpoint -- an unexpected
  // interstitial is the classic one -- has to be dismissed and the checkpoint
  // re-tested. Recovering and then reporting failure anyway would make the
  // whole recovery mechanism decorative.
  let arrived: Observation | null = null;
  let lastSeen: Observation | null = null;
  for (let attempt = 1; attempt <= 3 && !arrived; attempt++) {
    const settled = await surface.waitUntil(
      (o) => evaluateAssertion(o, a.checkpoint, opts.inputs).held || matchOutcome(a, o, opts.inputs) !== null,
      { timeoutMs: stepTimeout },
    );
    lastSeen = settled ?? (await surface.observe());
    if (evaluateAssertion(lastSeen, a.checkpoint, opts.inputs).held) { arrived = lastSeen; break; }

    const m = matchOutcome(a, lastSeen, opts.inputs);
    if (!m) break;
    const handled = await handleOutcome(m, lastSeen);
    if (handled !== 'retry') return handled;
  }
  if (!arrived) {
    const current = lastSeen ?? (await surface.observe());
    return fail({
      code: 'checkpoint_failed',
      expected: describeAssertion(a.checkpoint, opts.inputs),
      observed: `${evaluateAssertion(current, a.checkpoint, opts.inputs).detail} (at ${current.location})`,
    });
  }
  log.saveScreenshot(await surface.screenshot(), 'checkpoint');

  // --- Outputs ------------------------------------------------------------
  const outputs: Record<string, unknown> = {};
  for (const spec of a.outputs) {
    const r = surface.resolve(arrived, spec.from, opts.inputs);
    if (!r.ok) {
      return fail({
        code: 'output_missing',
        expected: `output "${spec.name}" at ${describeTarget(spec.from)}`,
        observed: r.reason === 'ambiguous' ? `${r.candidates.length} candidates` : 'not present on the checkpoint screen',
      });
    }
    const raw = r.node.name || r.node.value;
    outputs[spec.name] = applyTransform(raw, spec.transform);

    // Identity check. Reaching the right screen is not the same as reaching
    // the right record — see mustMatchParam in schema/artifact.ts.
    if (spec.mustMatchParam) {
      const expected = String(opts.inputs[spec.mustMatchParam] ?? '');
      if (norm(raw) !== norm(expected)) {
        return fail({
          code: 'output_mismatch',
          expected: `"${spec.name}" to echo the "${spec.mustMatchParam}" input (${expected})`,
          observed: `the screen reports ${JSON.stringify(raw)} — this is a different record`,
        });
      }
    }
  }
  log.append('agent', 'outputs', { outputs: redactOutputs(outputs) });

  return done({ status: 'success', outputs } as never);

  // --- Outcome handling ---------------------------------------------------
  async function handleOutcome(m: Matched, obs: Observation): Promise<ReplayResult | 'retry'> {
    const { outcome } = m;
    log.append('system', 'outcome.matched', {
      name: outcome.name, classification: outcome.classification, detail: m.detail, location: obs.location,
    }, log.saveScreenshot(await surface.screenshot(), `outcome-${outcome.name}`));

    switch (outcome.classification) {
      case 'business_outcome':
        // NOT a failure. A real answer the caller asked for.
        return done({ status: 'business_outcome', outcome: outcome.name, message: outcome.message } as never);

      case 'recoverable': {
        const rec = outcome.recovery;
        if (!rec) return 'retry';
        if (rec.kind === 'wait') { await surface.waitForStable({ timeoutMs: rec.timeoutMs }); return 'retry'; }
        if (rec.kind === 'retryStep') return 'retry';
        const rr = surface.resolve(obs, rec.target);
        if (!rr.ok) {
          return fail({
            code: 'app_error',
            expected: `recovery control ${describeTarget(rec.target)} for outcome "${outcome.name}"`,
            observed: 'the interstitial was detected but its dismiss control was not found',
          });
        }
        await surface.act(obs, rr.node, { kind: 'click' });
        await surface.waitForStable();
        log.append('system', 'outcome.recovered', { name: outcome.name, via: rec.kind });
        return 'retry';
      }

      case 'hard_failure':
        return fail({ code: 'app_error', expected: 'the application to respond normally', observed: outcome.message });

      case 'escalate': {
        const shot = log.saveScreenshot(await surface.screenshot(), 'escalate');
        return done({
          status: 'escalated', reason: outcome.message,
          context: { location: obs.location, screenshot: shot },
        } as never);
      }
    }
  }
}

function describeAssertion(a: StateAssertion, params?: Record<string, unknown>): string {
  const t = (d: Parameters<typeof describeTarget>[0]) => describeTarget(params ? interpolate(d, params) : d);
  switch (a.kind) {
    case 'nodeExists': return `${t(a.target)} present`;
    case 'nodeAbsent': return `${t(a.target)} absent`;
    case 'textPresent': return `text "${a.text}" present`;
    case 'locationMatches': return `location matching ${a.pattern}`;
    case 'all': return a.of.map((x) => describeAssertion(x, params)).join(' AND ');
  }
}
