/**
 * Print the normalised accessibility graph for a URL, as the model and the
 * resolver see it.
 *
 *   npx tsx scripts/observe.ts http://localhost:8710/?tenant=harbor
 */
import { PlaywrightSurface } from '../src/surface/playwright.js';

const url = process.argv[2] ?? 'http://localhost:8710/';
const s = await PlaywrightSurface.launch();
try {
  await s.navigate(url);
  await s.waitForStable();
  const o = await s.observe();
  console.log(`location: ${o.location}`);
  console.log(`frames  : ${o.frames.map((f) => f.name).join(', ')}\n`);
  for (const f of o.frames) {
    const ns = o.nodes.filter((n) => n.frame === f.name);
    if (!ns.length) continue;
    console.log(`frame "${f.name}"`);
    for (const n of ns) {
      let line = `  [${n.ref}] ${n.role.padEnd(9)}`;
      if (n.name) line += ` "${n.name}"`;
      if (n.anchorText) line += ` anchor="${n.anchorText}" (${n.anchorRelation})`;
      if (n.value) line += ` value="${n.value}"`;
      if (n.states.length) line += ` [${n.states.join(',')}]`;
      console.log(line);
    }
    console.log('');
  }
} finally {
  await s.close();
}
