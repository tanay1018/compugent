/**
 * Replay a capability deterministically. NO MODEL IS INVOKED.
 *
 *   npm run replay -- member.readSavingsBalance memberId=12345
 *   npm run replay -- member.readSavingsBalance memberId=99999
 *   npm run replay -- member.readSavingsBalance memberId=12345 --unattended
 */
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { ArtifactStore } from '../src/store/artifacts.js';
import { defaultPolicy } from '../src/policy/allowlist.js';
import { RunLog } from '../src/run/log.js';
import { describeTarget } from '../src/schema/assertion.js';
import { replay } from '../src/replay/engine.js';
import { HandoffSession } from '../src/hitl/session.js';
import { OperatorConsole } from '../src/hitl/console.js';

const args = process.argv.slice(2);
const id = args.find((a) => !a.includes('=') && !a.startsWith('--')) ?? 'member.readSavingsBalance';
const unattended = args.includes('--unattended');
const inputs: Record<string, string> = {};
for (const a of args) { const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(a); if (m) inputs[m[1]!] = m[2]!; }

const urlFlag = args.indexOf('--url');
const port = process.env.TARGET_APP_PORT ?? '8710';
const tenant = process.env.TENANT ?? 'meridian';
// --url points the SAME artifact at a different host. That is the multi-tenant
// seam in miniature: the artifact stores a route pattern, never an origin.
const baseUrl = urlFlag >= 0 ? args[urlFlag + 1]! : `http://localhost:${port}/?tenant=${tenant}`;

const asJson = args.includes('--json');
const artifact = new ArtifactStore().load(id);
const repeatFlag = args.indexOf('--repeat');
const repeat = repeatFlag >= 0 ? Math.max(1, Number(args[repeatFlag + 1] ?? 1)) : 1;

/**
 * Repeat mode answers "is this actually deterministic?" by measuring rather
 * than asserting. Determinism is a claim about REPETITION, and the only
 * evidence for it is repetition.
 */
if (repeat > 1) {
  const runs: Array<{ status: string; outputs: string; tiers: string; ms: number }> = [];
  for (let i = 0; i < repeat; i++) {
    const s = await PlaywrightSurface.launch();
    const l = new RunLog('evidence', `stability-${Date.now()}-${i}`);
    try {
      const r = await replay({ artifact, inputs, surface: s, policy: defaultPolicy(new URL(baseUrl).origin),
                               log: l, baseUrl, unattended });
      runs.push({
        status: r.status,
        outputs: r.status === 'success' ? JSON.stringify(r.outputs) : (r as { outcome?: string }).outcome ?? '',
        // The tier each step resolved through: a step that sometimes matches by
        // name and sometimes by anchor is a descriptor drifting under you.
        tiers: r.steps.map((x) => `${x.index}:${x.resolvedVia ?? x.status}`).join(' '),
        ms: r.ms,
      });
    } finally { await s.close(); }
  }
  const distinct = (k: 'status' | 'outputs' | 'tiers') => new Set(runs.map((r) => r[k])).size;
  const times = runs.map((r) => r.ms);
  console.log(`\n${'─'.repeat(66)}`);
  console.log(`${artifact.id} v${artifact.version} × ${repeat}   inputs: ${JSON.stringify(inputs)}`);
  console.log('─'.repeat(66));
  for (const [i, r] of runs.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.status.padEnd(18)} ${String(r.ms).padStart(6)}ms  ${r.outputs.slice(0, 60)}`);
  }
  const stable = distinct('status') === 1 && distinct('outputs') === 1 && distinct('tiers') === 1;
  console.log(`\n  distinct statuses      ${distinct('status')}`);
  console.log(`  distinct outputs       ${distinct('outputs')}`);
  console.log(`  distinct resolution    ${distinct('tiers')}   (which tier each step matched through)`);
  console.log(`  timing                 ${Math.min(...times)}–${Math.max(...times)}ms`);
  console.log(`\n  ${stable ? '\x1b[32mSTABLE\x1b[0m — identical result, outputs and resolution path every run'
                            : '\x1b[31mFLAKY\x1b[0m — see the differing column above'}\n`);
  process.exit(stable ? 0 : 1);
}

const runId = `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const log = new RunLog('evidence', runId);
const surface = await PlaywrightSurface.launch();

/**
 * `--watch` hosts the same operator channel a discovery run uses, so a replay
 * can be watched rather than reported. The most characteristic thing this
 * system does -- retrace a recorded path, checking each waypoint before it
 * touches anything -- was previously invisible behind a JSON result.
 */
const watch = args.includes('--watch');
let session: HandoffSession | undefined;
let consoleSrv: OperatorConsole | undefined;
if (watch) {
  session = new HandoffSession(surface, log);
  await session.prepare();
  consoleSrv = new OperatorConsole(session, log, Number(process.env.CONSOLE_PORT ?? 8790));
  const url = await consoleSrv.start();
  console.log(`  watching at ${url}`);
  // The artifact's plan, up front: the point is that replay follows THIS and
  // nothing else, so the steps are announced before any of them run.
  console.log('__PLAN__' + JSON.stringify({
    id: artifact.id, version: artifact.version, approval: artifact.approval,
    steps: artifact.steps.map((s) => ({
      index: s.index, kind: s.kind, effect: s.effect,
      target: s.target ? describeTarget(s.target) : null,
      value: s.value?.from === 'param' ? `<${s.value.param}>`
           : s.value?.from === 'literal' ? s.value.value
           : s.value?.from === 'operator' ? '<operator>' : null,
    })),
    outputs: artifact.outputs.map((o) => ({ name: o.name, type: o.type })),
  }));
}

try {
  const result = await replay({
    artifact, inputs, surface, policy: defaultPolicy(new URL(baseUrl).origin),
    log, baseUrl, unattended,
  });

  if (asJson) {
    // Last line is the whole result, for programmatic callers (the desktop app).
    console.log('__RESULT__' + JSON.stringify(result));
    process.exitCode = result.status === 'failed' ? 1 : 0;
  } else {
  const bar = '─'.repeat(66);
  console.log(`\n${bar}`);
  console.log(`${artifact.id} v${artifact.version}   inputs: ${JSON.stringify(inputs)}`);
  console.log(bar);
  console.log(`STATUS   ${result.status.toUpperCase()}   (${result.ms}ms, no model invoked)`);

  switch (result.status) {
    case 'success':
      console.log(`OUTPUTS  ${JSON.stringify(result.outputs, null, 2).replace(/\n/g, '\n         ')}`);
      break;
    case 'business_outcome':
      console.log(`OUTCOME  ${result.outcome}`);
      console.log(`MESSAGE  ${result.message}`);
      console.log(`         ^ this is an ANSWER, not a crash — the caller must handle it`);
      break;
    case 'failed':
      console.log(`CODE     ${result.failure.code}`);
      if (result.failure.stepIndex) console.log(`STEP     ${result.failure.stepIndex} (${result.failure.stepId})`);
      console.log(`EXPECTED ${result.failure.expected}`);
      console.log(`OBSERVED ${result.failure.observed}`);
      if (result.failure.screenshot) console.log(`EVIDENCE ${log.dir}/${result.failure.screenshot}`);
      break;
    case 'escalated':
      console.log(`REASON   ${result.reason}`);
      console.log(`AT       ${result.atStep ? `step ${result.atStep}` : 'checkpoint'} · ${result.context.location}`);
      if (result.context.screenshot) console.log(`EVIDENCE ${log.dir}/${result.context.screenshot}`);
      break;
  }

  console.log(`\nSTEPS`);
  for (const s of result.steps) {
    const mark = s.status === 'ok' ? '✓' : s.status === 'recovered' ? '↻' : s.status === 'skipped' ? '·' : '✗';
    console.log(`  ${mark} ${s.index}. ${s.kind.padEnd(7)} ${(s.target ?? '').slice(0, 46).padEnd(46)} ${String(s.ms).padStart(5)}ms${s.resolvedVia ? `  via:${s.resolvedVia}` : ''}`);
    if (s.note) console.log(`      ${s.note}`);
  }
  console.log(`\nevidence: ${log.dir}\n`);
  process.exitCode = result.status === 'failed' ? 1 : 0;
  }
  if (watch) {
    console.log('__REPLAY_DONE__' + JSON.stringify({
      status: result.status, ms: result.ms, runDir: log.dir,
      outputs: result.status === 'success' ? result.outputs : undefined,
      outcome: (result as { outcome?: string }).outcome,
      failure: (result as { failure?: unknown }).failure,
      reason: (result as { reason?: string }).reason,
    }));
    // Leave the stage up so the final screen stays on view.
    await new Promise(() => {});
  }
} finally {
  await consoleSrv?.stop();
  await session?.stop();
  await surface.close();
}
