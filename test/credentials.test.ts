import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCredentialField, defaultPolicy, isSensitiveField, redactValue } from '../src/policy/allowlist.js';
import { CapabilityArtifact } from '../src/schema/artifact.js';

const policy = defaultPolicy('http://localhost:8710');

test('automation is REFUSED a credential field, not merely redacted afterwards', () => {
  // Redacting the log is a consolation prize: by then the value has been typed
  // into a live system by something that cannot be held accountable for it.
  for (const label of ['Password', 'PIN', 'SSN', 'Card Number', 'Security Code']) {
    const d = checkCredentialField(policy, { kind: 'type', text: 'anything' }, label);
    assert.equal(d.allow, false, `${label} must be refused`);
    assert.equal(d.allow === false && d.code, 'credential');
  }
});

test('ordinary fields are untouched', () => {
  for (const label of ['Member ID', 'Search Type', 'Account Number']) {
    // "Account Number" IS in the sensitive list — deliberately, it is regulated.
    const expected = isSensitiveField(policy, label);
    assert.equal(checkCredentialField(policy, { kind: 'type', text: 'x' }, label).allow, expected ? false : true);
  }
  assert.equal(checkCredentialField(policy, { kind: 'type', text: 'x' }, 'Member ID').allow, true);
});

test('clicking a control is never a credential concern', () => {
  assert.equal(checkCredentialField(policy, { kind: 'click' }, 'Password').allow, true);
});

test('a sensitive value never survives logging', () => {
  assert.equal(redactValue(policy, 'Password', 'hunter2'), '[REDACTED]');
  assert.equal(redactValue(policy, 'Member ID', '12345'), '12345');
});

const base = {
  schemaVersion: 1 as const, id: 'bank.login', version: 1, name: 'n', description: 'd',
  app: { vendorProduct: 'v', recordedTenant: 't', surfaceKind: 'web' as const, entryPathPattern: '^/', entryPath: '/' },
  inputs: [], outputs: [], outcomes: [],
  checkpoint: { kind: 'textPresent' as const, text: 'Signed in' },
  provenance: { recordedAt: 'now', discoveryRunId: 'r', model: 'm', goal: 'g', warnings: [] },
};
const target = { role: 'textbox' as const, name: 'Password', nameMatch: 'normalized' as const, fallbacks: [] };

test('an artifact may DECLARE that a step needs a human, without holding the value', () => {
  // This is how a flow behind a login is expressible at all: not a param (the
  // caller would hold it), not a literal (the file would), not automation's to
  // type. Replay escalates when it reaches one.
  const a = CapabilityArtifact.parse({
    ...base,
    steps: [{
      id: 's1', index: 1, kind: 'type', target, effect: 'reversible',
      value: { from: 'operator', prompt: 'Sign in as the servicing operator' },
    }],
  });
  assert.equal(a.steps[0]!.value!.from, 'operator');
});

test('a stored literal that looks like a credential is rejected outright', () => {
  assert.throws(
    () => CapabilityArtifact.parse({
      ...base,
      steps: [{ id: 's1', index: 1, kind: 'type', target, effect: 'reversible',
                value: { from: 'literal', value: 'passw0rd' } }],
    }),
    /looks like a credential/,
  );
});
