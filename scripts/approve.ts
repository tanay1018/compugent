/**
 * Promote a reviewed capability.
 *
 *   npm run approve -- member.readSavingsBalance 2
 *
 * The only route to `approved`, which is what unattended replay requires — and
 * what stops a later, worse draft from shadowing a working capability.
 */
import { ArtifactStore } from '../src/store/artifacts.js';

const [id, v] = process.argv.slice(2);
const store = new ArtifactStore();
if (!id) {
  console.log('\nusage: npm run approve -- <capability.id> [version]\n');
  for (const c of store.list()) {
    const versions = store.versions(c.id);
    const states = versions.map((n) => {
      const a = store.load(c.id, n);
      return `v${n}:${a.approval}`;
    });
    console.log(`  ${c.id.padEnd(36)} ${states.join('  ')}`);
  }
  console.log('');
  process.exit(0);
}
const version = v ? Number(v) : store.versions(id).at(-1)!;
const a = store.approve(id, version);
console.log(`\n${a.id} v${a.version} → approved`);
console.log(`  ${a.steps.length} steps · ${a.outputs.length} outputs · ${a.outcomes.length} outcomes`);
console.log(`  callers now get this version even if a later draft exists.\n`);
