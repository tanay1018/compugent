/**
 * Prove a capability generalises before anyone is allowed to trust it.
 *
 *   npm run verify -- company.readWikipediaInfobox \
 *     --case "companyName=Bank of America" --case "companyName=Microsoft"
 *
 * A capability that only works for the value it was recorded against is not a
 * capability, it is a recording. The difference is invisible from a single
 * green run -- the recorded case passes by construction -- so the only honest
 * evidence is a run against a value the artifact has never seen.
 *
 * This is the gate that catches what neither the model nor the compiler can.
 * A discovery agent picks a checkpoint from what is on the screen in front of
 * it, and cannot know that Wikipedia's "discuss this issue" banner is a
 * maintenance notice on one article rather than part of every article. The
 * compiler cannot know either; it only sees one trace. Running a second value
 * settles it in seconds, and the failure is specific: the capability walked to
 * the right page and then could not prove it had arrived.
 *
 * With --approve, promotion is CONDITIONAL on that evidence, which is what
 * makes `approved` mean something stronger than `draft` rather than just older.
 */
import { ArtifactStore } from '../src/store/artifacts.js';
import { replay } from '../src/replay/engine.js';
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { defaultPolicy } from '../src/policy/allowlist.js';
import { RunLog } from '../src/run/log.js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--') && !a.includes('='));
const wantApprove = args.includes('--approve');

const cases: Record<string, string>[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--case') continue;
  const spec = args[i + 1] ?? '';
  const inputs: Record<string, string> = {};
  for (const pair of spec.split(';')) {
    const m = /^\s*([A-Za-z0-9_]+)=(.*)$/.exec(pair);
    if (m) inputs[m[1]!] = m[2]!;
  }
  if (Object.keys(inputs).length) cases.push(inputs);
}

if (!id || cases.length < 2) {
  console.log(`
usage: npm run verify -- <capability.id> --case "p=v" --case "p=other" [--approve]

  At least two cases are required, and they must differ: one value proves
  nothing about a second. Use --approve to promote only if every case passes.
`);
  process.exit(id ? 1 : 0);
}

const store = new ArtifactStore();
const version = store.versions(id).at(-1)!;
const artifact = store.load(id, version);

const recordedExample = Object.fromEntries(artifact.inputs.map((i) => [i.name, i.example]));
const host = artifact.app?.recordedTenant;
const baseUrl = host?.includes('.')
  ? `https://${host}${artifact.app.entryPath || '/'}`
  : `http://localhost:${process.env.TARGET_APP_PORT ?? '8710'}/?tenant=${process.env.TENANT ?? 'meridian'}`;

console.log(`\n${'─'.repeat(66)}`);
console.log(`verify  ${artifact.id} v${version}   (${artifact.approval})`);
console.log(`recorded against  ${JSON.stringify(recordedExample)}`);
console.log(`${'─'.repeat(66)}\n`);

type Result = { inputs: Record<string, string>; ok: boolean; detail: string; novel: boolean };
const results: Result[] = [];

for (const inputs of cases) {
  const novel = artifact.inputs.some((i) => i.example !== undefined && inputs[i.name] !== i.example);
  const surface = await PlaywrightSurface.launch();
  try {
    await surface.navigate(baseUrl);
    const log = new RunLog('evidence', `verify-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const r = await replay({ artifact, inputs, surface, log, baseUrl,
                             // Attended: unattended replay requires `approved`, and approval is
                             // what this script exists to earn. Verifying a draft is the point.
                             policy: defaultPolicy(new URL(baseUrl).origin), unattended: false });
    // A `business_outcome` is the surface answering the question -- "no such
    // company" -- not the capability breaking. It counts as completing: the
    // artifact drove the screen correctly and read a determinate answer.
    const ok = r.status === 'success' || r.status === 'business_outcome';
    const detail =
      r.status === 'success'          ? JSON.stringify(r.outputs)
      : r.status === 'business_outcome' ? `outcome: ${r.outcome} — ${r.message}`
      : r.status === 'escalated'        ? `escalated: ${r.reason}`
      : `${r.failure.code}: ${String(r.failure.observed).slice(0, 90)}`;
    results.push({ inputs, ok, novel, detail });
  } catch (e) {
    results.push({ inputs, ok: false, novel, detail: `threw: ${(e as Error).message.slice(0, 90)}` });
  } finally {
    await surface.close();
  }
}

for (const r of results) {
  const tag = r.ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mfail\x1b[0m';
  const mark = r.novel ? 'unseen ' : 'recorded';
  console.log(`  ${tag}  ${mark}  ${JSON.stringify(r.inputs)}`);
  console.log(`          ${r.detail}\n`);
}

const passedNovel = results.filter((r) => r.ok && r.novel).length;
const failed = results.filter((r) => !r.ok);

// Passing only the value it was recorded on is exactly the failure mode this
// script exists to catch, so it is reported as such rather than as a pass.
const generalises = failed.length === 0 && passedNovel > 0;

console.log('─'.repeat(66));
if (generalises) {
  console.log(`\x1b[32mGENERALISES\x1b[0m — ${passedNovel} of ${results.length} cases used values it was never recorded against`);
} else if (failed.length && failed.every((r) => r.novel)) {
  console.log(`\x1b[31mPINNED\x1b[0m — works on the recorded value and fails on values it has not seen.`);
  console.log(`  Something in this artifact is specific to how it was recorded.`);
  console.log(`  The failure above names it: whatever could not be found is the pinned part.`);
} else {
  console.log(`\x1b[31mFAILED\x1b[0m — ${failed.length} case(s) did not complete, including its own recorded value.`);
}
console.log('─'.repeat(66) + '\n');

if (wantApprove) {
  if (!generalises) {
    console.log('not approved: promotion requires evidence it works on a value it was not recorded against.\n');
    process.exit(1);
  }
  const a = store.approve(id, version);
  console.log(`${a.id} v${a.version} → approved, on ${results.length} verified cases.\n`);
}
process.exit(generalises ? 0 : 1);
