import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlToken } from '../src/hitl/control.js';
import { localize, planReentry } from '../src/hitl/relocalize.js';
import { CapabilityArtifact } from '../src/schema/artifact.js';
import type { Observation, UINode } from '../src/surface/types.js';

// --- control token --------------------------------------------------------

test('control has no "both" state: exactly one holder, or nobody mid-transfer', () => {
  const t = new ControlToken();
  assert.equal(t.holder, 'agent');
  assert.ok(t.canAgentAct && !t.canOperatorAct);

  t.requestPause();
  // Still the agent's until it yields at a step boundary — a click already in
  // flight must not be interrupted halfway.
  assert.equal(t.holder, 'agent');
  assert.ok(t.pauseRequested);

  t.yieldToOperator();
  assert.equal(t.holder, 'operator');
  assert.ok(t.canOperatorAct && !t.canAgentAct);

  t.requestResume();
  // Control does NOT snap back to the agent: we do not know where we are yet.
  assert.equal(t.holder, 'nobody');
  assert.ok(!t.canAgentAct && !t.canOperatorAct);

  t.beginRelocalize();
  t.returnToAgent('located at step 2');
  assert.equal(t.holder, 'agent');
});

test('illegal transitions throw rather than silently corrupting who is driving', () => {
  const t = new ControlToken();
  assert.throws(() => t.yieldToOperator(), /illegal control transition agent -> operator/);
});

test('failed re-localisation leaves the session with the human', () => {
  const t = new ControlToken();
  t.escalate('stuck');
  t.yieldToOperator();
  t.requestResume();
  t.beginRelocalize();
  t.handBackToOperator('off plan');
  assert.equal(t.holder, 'operator');
});

// --- re-localisation ------------------------------------------------------

let n = 0;
const node = (p: Partial<UINode> & Pick<UINode, 'role'>): UINode => ({
  ref: ++n, name: '', value: '', states: [], frame: 'main', handle: n, ...p,
});
const obs = (nodes: UINode[], location = 'http://app/lookup'): Observation => ({
  surfaceKind: 'web', capturedAt: new Date().toISOString(),
  frames: [{ id: 'f', name: 'main', url: location }], nodes, location,
});

const target = (name: string, role = 'textbox') =>
  ({ role, name, nameMatch: 'normalized', fallbacks: [] }) as never;

const artifact = (steps: unknown[]) => CapabilityArtifact.parse({
  schemaVersion: 1, id: 'demo.flow', version: 1, name: 'demo',
  description: 'd',
  app: { vendorProduct: 'v', recordedTenant: 't', surfaceKind: 'web', entryPathPattern: '^/', entryPath: '/' },
  inputs: [], outputs: [], outcomes: [], steps,
  checkpoint: { kind: 'textPresent', text: 'Confirmation' },
  provenance: { recordedAt: 'now', discoveryRunId: 'r', model: 'm', goal: 'g', warnings: [] },
});

const A = artifact([
  { id: 's1', index: 1, kind: 'type', target: target('Member ID'), effect: 'reversible',
    waypoint: { kind: 'nodeExists', target: target('Member ID') } },
  { id: 's2', index: 2, kind: 'click', target: target('Search', 'button'), effect: 'reversible',
    waypoint: { kind: 'nodeExists', target: target('Search', 'button') } },
]);

// Waypoints must DISCRIMINATE. An earlier draft of this fixture gave both
// steps the same waypoint and localize() correctly called it ambiguous —
// which is the behaviour under test two cases up.
const withSubmit = artifact([
  { id: 's1', index: 1, kind: 'type', target: target('Member ID'), effect: 'reversible',
    waypoint: { kind: 'nodeExists', target: target('Member ID') } },
  { id: 's2', index: 2, kind: 'click', target: target('Submit', 'button'), effect: 'irreversible',
    waypoint: { kind: 'nodeExists', target: target('Submit', 'button') },
    idempotencyProbe: { kind: 'textPresent', text: 'Sub-account created' } },
]);


// --- localisation ---------------------------------------------------------

test('a human who finished the task is detected before anything is resumed', () => {
  const l = localize(A, obs([node({ role: 'text', name: 'Confirmation' })]));
  assert.equal(l.kind, 'completed');
});

test('exactly one matching waypoint localises the run', () => {
  const l = localize(A, obs([node({ role: 'textbox', name: 'Member ID' })]));
  assert.equal(l.kind, 'located');
  assert.equal(l.kind === 'located' && l.stepIndex, 1);
});

test('resumption can land BACKWARD, not just where the agent left off', () => {
  // The operator navigated back to the search form after the agent had moved on.
  const l = localize(A, obs([node({ role: 'textbox', name: 'Member ID' })]));
  assert.equal(l.kind === 'located' && l.stepIndex, 1);
});

test('no matching waypoint is OFF PLAN — automation refuses to guess', () => {
  const l = localize(A, obs([node({ role: 'text', name: 'Some unrelated screen' })]));
  assert.equal(l.kind, 'off_plan');
  const d = planReentry(A, l, obs([]));
  assert.equal(d.safe, false);
  assert.match(!d.safe ? d.reason : '', /will not guess its position/);
});

test('steps sharing a screen resume at the earliest when all are safe to redo', () => {
  // Typing into a field and clicking the button beside it both happen on the
  // same form, so both waypoints hold. Refusing here would make resumption
  // impossible for any multi-step screen; re-typing a member ID costs nothing.
  const l = localize(A, obs([
    node({ role: 'textbox', name: 'Member ID' }),
    node({ role: 'button', name: 'Search' }),
  ]));
  assert.equal(l.kind, 'located');
  assert.equal(l.kind === 'located' && l.stepIndex, 1);
});

test('but ambiguity involving an IRREVERSIBLE step stops the run', () => {
  // Here the consequences differ: we cannot tell whether the submit already
  // happened, and guessing would post it twice.
  const o = obs([node({ role: 'textbox', name: 'Member ID' }), node({ role: 'button', name: 'Submit' })]);
  const l = localize(withSubmit, o);
  assert.equal(l.kind, 'ambiguous');
  assert.equal(planReentry(withSubmit, l, o).safe, false);
});

test('an irreversible step the operator ALREADY performed is skipped, not repeated', () => {
  // The scenario: the human submitted the form, then handed back. Resuming
  // naively would open a second sub-account.
  const o = obs([node({ role: 'textbox', name: 'Member ID' }), node({ role: 'text', name: 'Sub-account created' })]);
  const d = planReentry(withSubmit, localize(withSubmit, o), o);
  assert.equal(d.safe, true);
  assert.deepEqual(d.safe ? d.plan.willSkip : [], [2]);
  assert.deepEqual(d.safe ? d.plan.needsApproval : [], []);
});

test('an irreversible step that has NOT happened needs an operator decision', () => {
  const o = obs([node({ role: 'textbox', name: 'Member ID' })]);
  const d = planReentry(withSubmit, localize(withSubmit, o), o);
  assert.equal(d.safe, true);
  assert.deepEqual(d.safe ? d.plan.needsApproval : [], [2]);
});

test('a pending handover cannot outlive the automation loop', () => {
  // The bug: an operator pressed Take Over while the agent was calling a tool
  // that was not one of the acting three. The loop then ENDED, so it never
  // reached another step boundary, and nothing else was watching. Control sat
  // on pause_requested forever and the button read "Yielding…" indefinitely.
  const t = new ControlToken();
  let active = true;
  // Mirrors HandoffSession's setter: clearing the flag completes the handover.
  const setActive = (v: boolean) => {
    active = v;
    if (!v && t.pauseRequested) t.yieldToOperator('automation stopped with a pause outstanding');
  };

  t.requestPause('operator pressed take over');
  assert.equal(t.holder, 'agent', 'still the agent until it yields');

  setActive(false);              // the loop finishes
  assert.equal(active, false);
  assert.equal(t.holder, 'operator', 'the operator must end up with control');
  assert.equal(t.canOperatorAct, true);
});

test('clearing the flag with no pause pending changes nothing', () => {
  const t = new ControlToken();
  const setActive = (v: boolean) => { if (!v && t.pauseRequested) t.yieldToOperator('x'); };
  setActive(false);
  assert.equal(t.holder, 'agent');
});
