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
import { replay } from '../src/replay/engine.js';

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
const runId = `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const log = new RunLog('evidence', runId);
const surface = await PlaywrightSurface.launch();

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
} finally {
  await surface.close();
}
