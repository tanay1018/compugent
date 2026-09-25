import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLocation, defaultPolicy } from '../src/policy/allowlist.js';
import { loadPolicy } from '../src/policy/load.js';

const withPolicyFile = <T>(contents: unknown, fn: () => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  const path = join(dir, 'policy.json');
  writeFileSync(path, JSON.stringify(contents));
  const prev = process.env.POLICY_FILE;
  process.env.POLICY_FILE = path;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.POLICY_FILE; else process.env.POLICY_FILE = prev;
  }
};

test('a policy file is loaded and enforced as written', () => {
  withPolicyFile({ allowedOrigins: ['https://a.example'], allowedActions: ['click', 'read'] }, () => {
    const { policy, source } = loadPolicy('https://a.example/start');
    assert.deepEqual(policy.allowedOrigins, ['https://a.example']);
    assert.deepEqual(policy.allowedActions, ['click', 'read']);
    assert.match(source, /policy\.json$/);
  });
});

test('a malformed policy file stops the run instead of being ignored', () => {
  withPolicyFile({ allowedOrigins: ['not a url'] }, () => {
    assert.throws(() => loadPolicy('https://a.example/'), /invalid policy file/);
  });
});

test('with no policy file, only the entry origin is allowed', () => {
  const prev = process.env.POLICY_FILE;
  process.env.POLICY_FILE = join(tmpdir(), 'does-not-exist', 'policy.json');
  try {
    const { policy, source } = loadPolicy('https://b.example/x');
    assert.deepEqual(policy.allowedOrigins, ['https://b.example']);
    assert.match(source, /entry origin only/);
  } finally {
    if (prev === undefined) delete process.env.POLICY_FILE; else process.env.POLICY_FILE = prev;
  }
});

test('acting on a page outside the allowlist is refused, even after a click took us there', () => {
  const policy = defaultPolicy('http://localhost:8710');
  assert.equal(checkLocation(policy, 'http://localhost:8710/detail?q1=1').allow, true);
  const d = checkLocation(policy, 'https://elsewhere.example/phish');
  assert.equal(d.allow, false);
  assert.match((d as { reason: string }).reason, /outside the allowlist/);
  // Blank documents between loads are not a location.
  assert.equal(checkLocation(policy, 'about:blank').allow, true);
});
