import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityArtifact, toToolSchema } from '../src/schema/artifact.js';
import { canonicaliseLocation } from '../src/schema/canonical.js';

const base = {
  schemaVersion: 1 as const,
  id: 'member.readSavingsBalance',
  version: 1,
  name: 'Read savings balance',
  description: 'Look up a member and return their savings balance.',
  app: {
    vendorProduct: 'Corelink MemberDesk 7.2', recordedTenant: 'meridian',
    surfaceKind: 'web' as const, entryPathPattern: '^/(\\?|$)', entryPath: '/',
  },
  inputs: [{ name: 'memberId', type: 'string', required: true, description: 'member number', sensitive: false }],
  outputs: [],
  outcomes: [],
  checkpoint: { kind: 'textPresent' as const, text: 'Member Detail' },
  provenance: { recordedAt: new Date().toISOString(), discoveryRunId: 'r1', model: 'm', goal: 'g', warnings: [] },
};

const target = { role: 'textbox' as const, name: 'Member ID', nameMatch: 'normalized' as const, fallbacks: [] };

test('a step may not reference an undeclared parameter', () => {
  assert.throws(
    () => CapabilityArtifact.parse({
      ...base,
      steps: [{ id: 's1', index: 1, kind: 'type', target, value: { from: 'param', param: 'nope' }, effect: 'reversible' }],
    }),
    /undeclared parameter/,
  );
});

test('an IRREVERSIBLE step without an idempotency probe is rejected', () => {
  // The rule that stops a run resumed after a human takeover from opening a
  // second account. Without the probe, re-entry cannot know it already ran.
  assert.throws(
    () => CapabilityArtifact.parse({
      ...base,
      steps: [{ id: 's1', index: 1, kind: 'click', target: { ...target, role: 'button', name: 'Submit' }, effect: 'irreversible' }],
    }),
    /needs an idempotencyProbe/,
  );
});

test('an irreversible step WITH a probe is accepted', () => {
  const a = CapabilityArtifact.parse({
    ...base,
    steps: [{
      id: 's1', index: 1, kind: 'click', target: { ...target, role: 'button', name: 'Submit' },
      effect: 'irreversible',
      idempotencyProbe: { kind: 'textPresent', text: 'Sub-account created' },
    }],
  });
  assert.equal(a.steps[0]!.effect, 'irreversible');
});

test('artifacts default to draft, so unattended replay must be opted into', () => {
  const a = CapabilityArtifact.parse({
    ...base,
    steps: [{ id: 's1', index: 1, kind: 'type', target, value: { from: 'param', param: 'memberId' }, effect: 'reversible' }],
  });
  assert.equal(a.approval, 'draft');
});

test('the artifact projects to an agent-callable tool schema', () => {
  const a = CapabilityArtifact.parse({
    ...base,
    outputs: [{ name: 'savingsBalance', type: 'number', description: 'current balance', from: target, transform: 'currency', sensitive: false }],
    outcomes: [{
      name: 'member_not_found', classification: 'business_outcome',
      detect: { kind: 'textPresent', text: 'No member found' },
      message: 'No member matches that ID.', verified: true,
    }],
    steps: [{ id: 's1', index: 1, kind: 'type', target, value: { from: 'param', param: 'memberId' }, effect: 'reversible' }],
  });
  const t = toToolSchema(a);
  assert.equal(t.name, 'member_readSavingsBalance');
  assert.deepEqual((t.input_schema as { required: string[] }).required, ['memberId']);
  // A caller must be told that "not found" is a legitimate answer, not a crash.
  assert.match(t.description, /business outcomes instead: member_not_found/);
});

test('locations canonicalise to route patterns, dropping this run data', () => {
  const a = canonicaliseLocation('http://localhost:8710/detail?q1=12345&q2=M');
  assert.equal(a.pattern, '^/detail(\\?|$)');
  assert.ok(new RegExp(a.pattern).test('/detail?q1=99999&q2=S'), 'must match a different member');

  const b = canonicaliseLocation('https://bank.example/member/12345/accounts');
  assert.ok(new RegExp(b.pattern).test('/member/67890/accounts'));
  assert.ok(!new RegExp(b.pattern).test('/member/67890/loans'));
});
