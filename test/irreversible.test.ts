import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEffect, defaultPolicy } from '../src/policy/allowlist.js';
import type { UINode } from '../src/surface/types.js';

const policy = defaultPolicy('https://parabank.parasoft.com');
const node = (name: string): UINode =>
  ({ ref: 1, role: 'button', name, value: '', states: [], frame: 'main', handle: 1 });

test('creating a thing is irreversible, not just destroying one', () => {
  // Regression: account opening was classified as reversible.
  for (const label of ['Open New Account', 'Create Account', 'Register', 'Apply Now', 'Enroll']) {
    assert.equal(classifyEffect(policy, { kind: 'click' }, node(label)), 'irreversible', label);
  }
});

test('money movement stays irreversible', () => {
  for (const label of ['Transfer', 'Submit Payment', 'Send', 'Pay Bill', 'Authorize']) {
    assert.equal(classifyEffect(policy, { kind: 'click' }, node(label)), 'irreversible', label);
  }
});

test('navigation is not', () => {
  for (const label of ['Accounts Overview', 'Find Transactions', 'Log In', 'Search', 'New Search']) {
    assert.equal(classifyEffect(policy, { kind: 'click' }, node(label)), 'reversible', label);
  }
});

test('typing is reversible on its own — it is the submit that commits', () => {
  assert.equal(classifyEffect(policy, { kind: 'type', text: '1220' }, node('Amount:')), 'reversible');
});
