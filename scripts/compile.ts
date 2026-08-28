/**
 * Compile a discovery run into a capability artifact.
 *
 *   npm run compile                 # newest discovery run
 *   npm run compile -- <runDir>
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compileTrace } from '../src/compile/compiler.js';
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
const runDir = arg ?? join('evidence', readdirSync('evidence').filter((d) => d.startsWith('discovery-')).sort().at(-1)!);
const trace = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));

const { artifact, warnings } = await compileTrace({
  trace,
  discoveryRunId: runDir.split('/').at(-1)!,
  vendorProduct: process.env.VENDOR_PRODUCT ?? 'Corelink MemberDesk 7.2',
  tenant: new URL(trace.entryUrl).searchParams.get('tenant') ?? new URL(trace.entryUrl).hostname,
});

const path = new ArtifactStore().save(artifact);

console.log(`\n${'='.repeat(66)}`);
console.log(`${artifact.id} v${artifact.version}  [${artifact.approval}]`);
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
console.log(`  ${artifact.checkpoint.kind === 'nodeExists' ? describeTarget(artifact.checkpoint.target) : artifact.checkpoint.kind}`);
console.log(`\nOUTCOMES  ${artifact.outcomes.length === 0 ? '(none yet — learned in Phase 5 from runs that produce them)' : ''}`);
if (warnings.length) { console.log(`\nWARNINGS`); for (const w of warnings) console.log(`  - ${w}`); }
console.log(`\nsaved: ${path}`);
console.log(`\n--- as an agent-callable tool ---`);
console.log(JSON.stringify(toToolSchema(artifact), null, 2));
console.log('');
