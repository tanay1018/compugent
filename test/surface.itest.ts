import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { TargetDescriptor } from '../src/schema/target.js';

/**
 * End-to-end proof for Phase 2: observe -> resolve -> act against the real
 * legacy surface, driven ONLY by anchor relations. No CSS, no XPath, no test
 * ids, and for the L2 tenant not even a named button.
 */
const PORT = 8719;
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;
let s: PlaywrightSurface;

before(async () => {
  server = spawn('npx', ['tsx', 'target-app/server.ts'], {
    env: { ...process.env, TARGET_APP_PORT: String(PORT) }, stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${BASE}/lookup`); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  s = await PlaywrightSurface.launch();
});

after(async () => { await s?.close(); server?.kill('SIGKILL'); });

test('the legacy field is genuinely anonymous in the accessibility tree', async () => {
  await s.navigate(`${BASE}/?tenant=meridian`);
  const o = await s.observe();
  const box = o.nodes.find((n) => n.role === 'textbox');
  assert.ok(box, 'expected a textbox');
  assert.equal(box.name, '', 'the a11y tree must expose NO accessible name — that is the premise');
  assert.equal(box.anchorText, 'Member ID');
  assert.equal(box.anchorRelation, 'inSameRowAs');
});

test('drives search -> detail using anchors only (meridian / L1)', async () => {
  await s.navigate(`${BASE}/?tenant=meridian`);
  let o = await s.observe();

  const field = TargetDescriptor.parse({
    role: 'textbox', scope: { frame: 'main' },
    anchor: { relation: 'inSameRowAs', text: 'Member ID' },
  });
  const rf = s.resolve(o, field);
  assert.equal(rf.ok, true);
  assert.equal(rf.ok && rf.via, 'anchor');
  await s.act(o, (rf as any).node, { kind: 'type', text: '12345' });

  o = await s.observe();
  const btn = TargetDescriptor.parse({ role: 'button', name: 'Search', scope: { frame: 'main' } });
  const rb = s.resolve(o, btn);
  assert.equal(rb.ok, true);
  await s.act(o, (rb as any).node, { kind: 'click' });
  await s.waitForStable();

  o = await s.observe();
  const texts = o.nodes.map((n) => n.name);
  assert.ok(texts.includes('Sarah Chen'), `expected member name; saw ${JSON.stringify(texts.slice(0, 12))}`);
  assert.ok(texts.some((t) => t.includes('4,182.55')), 'expected the savings balance');
});

test('drives the L2 tenant where the SUBMIT BUTTON is also anonymous (harbor)', async () => {
  await s.navigate(`${BASE}/?tenant=harbor`);
  let o = await s.observe();

  // Harbor renames the field, so the anchor text differs — this is exactly the
  // per-tenant drift that a shared artifact must be specialised for.
  const field = TargetDescriptor.parse({
    role: 'textbox', scope: { frame: 'main' },
    anchor: { relation: 'inSameRowAs', text: 'Account Number' },
  });
  const rf = s.resolve(o, field);
  assert.equal(rf.ok, true, 'anchor must find the renamed field');
  await s.act(o, (rf as any).node, { kind: 'type', text: '67890' });

  o = await s.observe();
  // The author gave this image input no alt text -- Chrome SYNTHESISES the
  // name "Submit". Depending on that string is false confidence: it is a
  // browser default, not app content. The anchor is the durable identity.
  const btn = o.nodes.find((n) => n.role === 'button');
  assert.ok(btn, 'expected a submit control');
  assert.equal(btn.name, 'Submit', 'browser-synthesised name, not author content');
  assert.equal(btn.anchorText, 'Action', 'the anchor is what we actually trust');

  const rb = s.resolve(o, TargetDescriptor.parse({
    role: 'button', scope: { frame: 'main' },
    anchor: { relation: 'inSameRowAs', text: 'Action' },
  }));
  assert.equal(rb.ok, true, 'anchor must resolve the image submit');
  assert.equal(rb.ok && rb.via, 'anchor');
  await s.act(o, (rb as any).node, { kind: 'click' });
  await s.waitForStable();

  o = await s.observe();
  assert.ok(o.nodes.some((n) => n.name === 'Marcus Webb'), 'expected the L2 flow to complete');
});

test('a descriptor matching nothing fails loudly with the tiers it tried', async () => {
  await s.navigate(`${BASE}/?tenant=meridian`);
  const o = await s.observe();
  const r = s.resolve(o, TargetDescriptor.parse({
    role: 'textbox', name: 'Nonexistent Field',
    anchor: { relation: 'inSameRowAs', text: 'Nonexistent Field' },
  }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'not_found');
});
