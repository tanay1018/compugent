/**
 * Replay a capability deterministically. No model is invoked.
 *
 *   npm run replay -- member.readSavingsBalance memberId=12345
 *   npm run replay -- member.readSavingsBalance memberId=99999
 *   npm run replay -- member.readSavingsBalance memberId=12345 --unattended
 *   npm run replay -- member.readSavingsBalance memberId=12345 --latest       # newest version, even a draft
 *   npm run replay -- member.readSavingsBalance memberId=12345 --version 3
 */
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { ArtifactStore } from '../src/store/artifacts.js';
import { loadPolicy } from '../src/policy/load.js';
import { RunLog } from '../src/run/log.js';
import { describeTarget } from '../src/schema/assertion.js';
import { replay } from '../src/replay/engine.js';
import { HandoffSession } from '../src/hitl/session.js';
import { OperatorConsole } from '../src/hitl/console.js';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--url', '--repeat', '--version']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''));
const id = positional.find((a) => !a.includes('=')) ?? 'member.readSavingsBalance';
const versionFlag = args.indexOf('--version');
const pinned = versionFlag >= 0 ? Number(args[versionFlag + 1]) : undefined;
const unattended = args.includes('--unattended');
const inputs: Record<string, string> = {};
for (const a of positional) { const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(a); if (m) inputs[m[1]!] = m[2]!; }

// By default replay loads the highest approved version (see ArtifactStore.load).
// --latest and --version pick a specific one, e.g. a draft you just compiled.
const store = new ArtifactStore();
const artifact = pinned !== undefined ? store.load(id, pinned)
  : args.includes('--latest') ? store.load(id, store.versions(id).at(-1))
  : store.load(id);

function artifactOrigin(): string | undefined {
  const host = artifact?.app?.recordedTenant;
  if (!host || !host.includes('.')) return undefined;   // a tenant slug, not a host
  return `https://${host}${artifact.app.entryPath || '/'}`;
}

const urlFlag = args.indexOf('--url');
const port = process.env.TARGET_APP_PORT ?? '8710';
const tenant = process.env.TENANT ?? 'meridian';
// --url points the same artifact at a different host; artifacts store only a route pattern.

/**
 * Where to replay, in order of authority:
 *
 *   1. --url            an explicit override, always wins
 *   2. the artifact     the origin it was actually recorded against
 *   3. the local app    the development default
 *
 * `recordedTenant` is a tenant slug for the bundled app ("meridian") but a
 * hostname for public sites ("forecast.weather.gov"). A dot tells them apart.
 */
const recorded = artifactOrigin();
const baseUrl = urlFlag >= 0 ? args[urlFlag + 1]!
  : recorded ?? `http://localhost:${port}/?tenant=${tenant}`;

const asJson = args.includes('--json');
const { policy, source: policySource } = loadPolicy(baseUrl);
if (!asJson) console.log(`policy  ${policySource}`);

const repeatFlag = args.indexOf('--repeat');
const repeat = repeatFlag >= 0 ? Math.max(1, Number(args[repeatFlag + 1] ?? 1)) : 1;

/** --repeat: run N times and compare statuses, outputs and resolution tiers. */
if (repeat > 1) {
  const runs: Array<{ status: string; outputs: string; tiers: string; ms: number }> = [];
  for (let i = 0; i < repeat; i++) {
    const s = await PlaywrightSurface.launch();
    const l = new RunLog('evidence', `stability-${new Date().toISOString().replace(/[:.]/g, '-')}-${i}`);
    try {
      const r = await replay({ artifact, inputs, surface: s, policy,
                               log: l, baseUrl, unattended });
      runs.push({
        status: r.status,
        outputs: r.status === 'success' ? JSON.stringify(r.outputs) : (r as { outcome?: string }).outcome ?? '',
        // Resolution tier per step; a step switching tiers suggests UI drift.
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
  const consistent = distinct('status') === 1 && distinct('outputs') === 1 && distinct('tiers') === 1;
  // Only report STABLE (and exit 0) if the runs succeeded; identical failures
  // are consistent but not a pass.
  const working = runs.every((r) => r.status === 'success' || r.status === 'business_outcome');
  const stable = consistent && working;
  console.log(`\n  distinct statuses      ${distinct('status')}`);
  console.log(`  distinct outputs       ${distinct('outputs')}`);
  console.log(`  distinct resolution    ${distinct('tiers')}   (which tier each step matched through)`);
  console.log(`  timing                 ${Math.min(...times)}–${Math.max(...times)}ms`);
  const verdict =
    stable            ? '\x1b[32mSTABLE\x1b[0m — identical result, outputs and resolution path every run'
    : consistent      ? `\x1b[31mCONSISTENTLY FAILING\x1b[0m — every run ended "${runs[0]!.status}". Repeatable, but not working.`
    :                   '\x1b[31mFLAKY\x1b[0m — see the differing column above';
  console.log(`\n  ${verdict}\n`);
  process.exit(stable ? 0 : 1);
}

const runId = `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const log = new RunLog('evidence', runId);
const surface = await PlaywrightSurface.launch();

/** --watch: host the operator channel so the replay can be watched live. */
const watch = args.includes('--watch');
let session: HandoffSession | undefined;
let consoleSrv: OperatorConsole | undefined;
if (watch) {
  session = new HandoffSession(surface, log);
  await session.prepare();
  consoleSrv = new OperatorConsole(session, log, Number(process.env.CONSOLE_PORT ?? 8790));
  const url = await consoleSrv.start();
  console.log(`  watching at ${url}`);
  // Announce the plan before running it.
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
    artifact, inputs, surface, policy,
    log, baseUrl, unattended,
  });

  if (asJson) {
    // Last line is the JSON result, for the desktop app.
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
    const mark = s.status === 'ok' ? '✓' : s.status === 'recovered' ? '↻' : s.status === 'skipped' ? '·' : s.status === 'escalated' ? '!' : '✗';
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
