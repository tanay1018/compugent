import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from '../src/compile/compiler.js';
import type { TraceStep } from '../src/discovery/agent.js';

const { pruneCycles } = __testing;

/** `locationAfter` is where the step LEAVES you; the state it acts on is
 *  wherever the previous step left off. */
const step = (index: number, kind: TraceStep['kind'], locationAfter: string): TraceStep => ({
  index, kind, rationale: '',
  target: { role: 'button', name: `b${index}`, nameMatch: 'normalized', fallbacks: [] },
  targetVerified: true, effect: 'reversible', locationAfter,
});
const idx = (s: TraceStep[]) => s.map((x) => x.index);

const L = 'http://app/lookup', D = 'http://app/detail', X = 'http://app/other';

test('sequential steps on ONE screen are not a cycle', () => {
  // Typing into a field and clicking the button beside it both happen on the
  // lookup screen. Treating a repeated location as a loop would delete the type.
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
  // lookup(1,2) -> detail(3,4) -> back to lookup(5,6). Everything before the
  // return is work the run itself abandoned.
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
  // Step 1 survives: it is how you reach D at all. Step 2 does NOT, even
  // though it preceded the detour — re-entering D gets it fresh, so whatever
  // step 2 did there is gone. Steps 3 and 4 are the detour itself.
  const { kept, dropped } = pruneCycles([
    step(1, 'click', D), step(2, 'click', D), step(3, 'click', X),
    step(4, 'click', D), step(5, 'click', D),
  ], L);
  assert.deepEqual(idx(kept), [1, 5]);
  assert.deepEqual(idx(dropped), [2, 3, 4]);
});
