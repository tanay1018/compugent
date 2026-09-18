/**
 * Compile a discovery run into a capability artifact.
 *
 *   npm run compile                 # newest discovery run
 *   npm run compile -- <runDir>
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compileTrace, setVersionResolver } from '../src/compile/compiler.js';
import { ArtifactStore } from '../src/store/artifacts.js';
import { toToolSchema } from '../src/schema/artifact.js';
import { describeTarget } from '../src/schema/assertion.js';

for (const f of ['.env', '.env.local', '.env.txt']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]?.replace(/^["']|["']$/g, '') ?? '';
  }
}

const arg = process.argv[2];
// Both prefixes: `watch-` runs come from the desktop app and are exactly the
// ones a user is most likely to want compiled straight after recording.
const runs = readdirSync('evidence')
  .filter((d) => d.startsWith('discovery-') || d.startsWith('watch-'))
  // By mtime, not by name: run directories are prefixed with how they were
  // produced ("discovery-", "watch-"), so sorting by name ranked every watch
  // run above every discovery run no matter which actually ran last, and
  // `npm run compile` kept reaching for a stale trace.
  .sort((a, b) => statSync(join('evidence', a)).mtimeMs - statSync(join('evidence', b)).mtimeMs);
const latest = runs.at(-1);
if (!arg && !latest) { console.error('no discovery runs in evidence/'); process.exit(1); }
const runDir = arg ?? join('evidence', latest!);
console.log(`compiling ${runDir}`);
const trace = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));

const allowPartial = process.argv.includes('--partial');
const store = new ArtifactStore();
setVersionResolver((id) => store.nextVersion(id));

let compiled;
try {
  compiled = await compileTrace({
  trace,
  allowPartial,
  discoveryRunId: runDir.split('/').at(-1)!,
  knownCapabilities: new ArtifactStore().list().map((c) => {
    const a = new ArtifactStore().load(c.id);
    return { id: a.id, description: a.description };
  }),
    /**
     * The local demo app's name was the unconditional default, so it was
     * stamped onto every artifact -- a weather.gov capability and a Wikipedia
     * capability both claimed to be "Corelink MemberDesk 7.2". That is not
     * cosmetic: the Electron shell reads vendorProduct to decide where Run
     * Live should point, and sent both to localhost.
     *
     * The demo app is identified by a tenant query parameter; anything else is
     * a real site and names itself by its host.
     */
    vendorProduct: process.env.VENDOR_PRODUCT ?? (
      new URL(trace.entryUrl).searchParams.get('tenant')
        ? 'Corelink MemberDesk 7.2'
        : new URL(trace.entryUrl).hostname
    ),
    tenant: new URL(trace.entryUrl).searchParams.get('tenant') ?? new URL(trace.entryUrl).hostname,
  });
} catch (e) {
  // A stack trace tells the operator nothing they can act on.
  console.error(`\ncannot compile: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
const { artifact, warnings } = compiled;

let path: string;
try {
  path = store.save(artifact);
} catch (e) {
  console.error(`\ncannot save: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

console.log(`\n${'='.repeat(66)}`);
console.log(`${artifact.id} v${artifact.version}  [${artifact.approval}]`);
if (artifact.approval === 'incomplete') {
  console.log(`\n  \x1b[33mINCOMPLETE\x1b[0m — ${artifact.incompleteReason}`);
  console.log(`  The steps below are kept, but this cannot be invoked until the`);
  console.log(`  flow is finished and a checkpoint exists.`);
}
console.log(`${'='.repeat(66)}`);
console.log(`${artifact.description}\n`);
console.log(`INPUTS`);
for (const p of artifact.inputs) {
  console.log(`  ${p.name}: ${p.type}${p.required ? '' : '?'}${p.sensitive ? '  [sensitive]' : ''}`);
  console.log(`    ${p.description}`);
  console.log(`    example: ${p.example}`);
}
console.log(`\nOUTPUTS`);
for (const o of artifact.outputs) {
  console.log(`  ${o.name}: ${o.type} (${o.transform})`);
  console.log(`    located by: ${describeTarget(o.from)}`);
}
console.log(`\nSTEPS`);
for (const s of artifact.steps) {
  const v = s.value?.from === 'param' ? `<${s.value.param}>` : s.value?.from === 'literal' ? JSON.stringify(s.value.value) : '';
  console.log(`  ${s.index}. ${s.kind.padEnd(7)} ${s.target ? describeTarget(s.target) : ''} ${v}`);
  console.log(`     effect: ${s.effect}${s.fragile ? `   [FRAGILE: ${s.fragile}]` : ''}`);
}
console.log(`\nCHECKPOINT`);
if (!artifact.checkpoint) {
  console.log(`  none — the run never established what success looks like`);
} else if (artifact.checkpoint.kind === 'nodeExists') {
  console.log(`  ${describeTarget(artifact.checkpoint.target)}`);
} else {
  console.log(`  ${artifact.checkpoint.kind}`);
}
console.log(`\nOUTCOMES  ${artifact.outcomes.length === 0 ? '(none yet — learned in Phase 5 from runs that produce them)' : ''}`);
if (warnings.length) { console.log(`\nWARNINGS`); for (const w of warnings) console.log(`  - ${w}`); }
console.log(`\nsaved: ${path}`);
console.log(`\n--- as an agent-callable tool ---`);
console.log(JSON.stringify(toToolSchema(artifact), null, 2));
console.log('');
