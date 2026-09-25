import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from '../src/compile/compiler.js';
import type { TraceStep } from '../src/discovery/agent.js';

const { pruneCycles } = __testing;

/** `locationAfter` is where the step leaves you; a step acts on the previous step's location. */
const step = (index: number, kind: TraceStep['kind'], locationAfter: string): TraceStep => ({
  index, kind, rationale: '',
  target: { role: 'button', name: `b${index}`, nameMatch: 'normalized', fallbacks: [] },
  targetVerified: true, effect: 'reversible', locationAfter,
});
const idx = (s: TraceStep[]) => s.map((x) => x.index);

const L = 'http://app/lookup', D = 'http://app/detail', X = 'http://app/other';

test('sequential steps on ONE screen are not a cycle', () => {
  // Consecutive steps on one screen are not a cycle.
  const { kept, dropped } = pruneCycles([step(1, 'type', L), step(2, 'click', D)], L);
  assert.deepEqual(idx(kept), [1, 2]);
  assert.equal(dropped.length, 0);
});

test('a straight-line walk is left completely alone', () => {
  const { kept, dropped } = pruneCycles([step(1, 'click', D), step(2, 'click', X)], L);
  assert.deepEqual(idx(kept), [1, 2]);
  assert.equal(dropped.length, 0);
});

test('a dead end the run backtracked out of is dropped', () => {
  // lookup(1,2) -> detail(3,4) -> back to lookup(5,6): keep only 5 and 6.
  const { kept, dropped } = pruneCycles([
    step(1, 'type', L), step(2, 'click', D), step(3, 'click', D),
    step(4, 'click', L), step(5, 'type', L), step(6, 'click', D),
  ], L);
  assert.deepEqual(idx(kept), [5, 6]);
  assert.deepEqual(idx(dropped), [1, 2, 3, 4]);
});

test('returning to a screen discards the work done there before leaving it', () => {
  // L -(1)-> D, work at D (2), detour D -(3)-> X -(4)-> D, then finish (5).
  //
  // Step 1 is kept (it reaches D). Step 2 is dropped: re-entering D resets
  // it. Steps 3 and 4 are the detour.
  const { kept, dropped } = pruneCycles([
    step(1, 'click', D), step(2, 'click', D), step(3, 'click', X),
    step(4, 'click', D), step(5, 'click', D),
  ], L);
  assert.deepEqual(idx(kept), [1, 5]);
  assert.deepEqual(idx(dropped), [2, 3, 4]);
});
