import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { TargetDescriptor } from '../src/schema/target.js';

/** Typing into a prefilled field must replace its value, not append to it. */
const PORT = 8721;
let server: ChildProcess;
let s: PlaywrightSurface;

before(async () => {
  server = spawn('npx', ['tsx', 'target-app/server.ts'],
    { env: { ...process.env, TARGET_APP_PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://localhost:${PORT}/lookup`); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  s = await PlaywrightSurface.launch();
});
after(async () => { await s?.close(); server?.kill('SIGKILL'); });

test('a second type replaces the first, it does not append', async () => {
  await s.navigate(`http://localhost:${PORT}/?tenant=meridian`);
  await s.waitForStable();
  const field = TargetDescriptor.parse({
    role: 'textbox', scope: { frame: 'main' },
    anchor: { relation: 'inSameRowAs', text: 'Member ID' },
  });

  let o = await s.observe();
  let r = s.resolve(o, field);
  assert.equal(r.ok, true);
  assert.ok(r.ok); await s.act(o, r.node, { kind: 'type', text: '12345' });

  o = await s.observe();
  r = s.resolve(o, field);
  assert.ok(r.ok);
  await s.act(o, r.node, { kind: 'type', text: '67890' });

  const after2 = await s.observe();
  const val = await s.valueOf(s.resolve(after2, field));
  assert.equal(val, '67890', `expected replacement, got ${JSON.stringify(val)}`);
});
