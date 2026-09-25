import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { compactObservations } from '../src/discovery/compact.js';

/** A realistically sized screen (the target app renders ~15 nodes, Wikipedia ~1400). */
const OBS = (loc: string) =>
  `location: ${loc}\n\nframe "main"\n` +
  ['  [1] textbox anchored-to="Member ID" (inSameRowAs)',
   '  [2] combobox anchored-to="Search Type" (inSameRowAs) value="Member Number"',
   '  [3] button "Search"'].join('\n') + '\n' +
  Array.from({ length: 22 }, (_, i) =>
    `  [${i + 4}] text "Account row ${i} — some column label and its value"`).join('\n');

const toolMsg = (loc: string): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: 't' + loc, toolName: 'click',
              output: { type: 'text', value: `OK.\n\n${OBS(loc)}` } }],
} as ModelMessage);

const userMsg = (goal: string, loc: string): ModelMessage =>
  ({ role: 'user', content: `GOAL: ${goal}\n\nCurrent observation:\n${OBS(loc)}` } as ModelMessage);

const size = (ms: ModelMessage[]) => JSON.stringify(ms).length;

test('a single observation is left alone — nothing is stale yet', () => {
  const ms = [userMsg('read a balance', '/lookup')];
  assert.deepEqual(compactObservations(ms), ms);
});

test('older observations are stubbed, the newest is kept in full', () => {
  const ms = [userMsg('read a balance', '/lookup'), toolMsg('/lookup'), toolMsg('/detail')];
  const out = compactObservations(ms);

  const last = JSON.stringify(out[2]);
  assert.ok(last.includes('[1] textbox'), 'the current screen must survive intact');

  const first = JSON.stringify(out[1]);
  assert.ok(!first.includes('[1] textbox'), 'a stale screen must not be resent');
  assert.ok(first.includes('/lookup'), 'but where the run was is still recorded');
});

test('the goal survives compaction of the opening prompt', () => {
  const out = compactObservations([userMsg('read a balance', '/lookup'), toolMsg('/detail')]);
  const opening = JSON.stringify(out[0]);
  assert.ok(opening.includes('GOAL: read a balance'), 'the task itself is never dropped');
  assert.ok(!opening.includes('[2] button'), 'its stale screen is');
});

test('a ten-step conversation shrinks by most of its bulk', () => {
  // After compaction only one screen is full size, so payload size stops
  // growing with step count.
  const many: ModelMessage[] = [userMsg('read a balance', '/lookup')];
  for (let i = 0; i < 10; i++) many.push(toolMsg(`/screen${i}`));

  const before = size(many);
  const after = size(compactObservations(many));
  const saved = Math.round(100 - (100 * after) / before);
  console.log(`      ${before} -> ${after} chars (${saved}% smaller across 10 steps)`);
  assert.ok(saved >= 70, `expected >=70% smaller, got ${saved}%`);
});

test('the saving grows with the length of the run', () => {
  const run = (n: number) => {
    const ms: ModelMessage[] = [userMsg('g', '/a')];
    for (let i = 0; i < n; i++) ms.push(toolMsg(`/s${i}`));
    return { before: size(ms), after: size(compactObservations(ms)) };
  };
  const short = run(3), long = run(15);
  const shortSaving = 1 - short.after / short.before;
  const longSaving = 1 - long.after / long.before;
  assert.ok(longSaving > shortSaving, 'a longer run should benefit more, not less');
});
