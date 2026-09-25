import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/surface/resolve.js';
import { TargetDescriptor } from '../src/schema/target.js';
import type { Observation, UINode } from '../src/surface/types.js';

/**
 * Fixture-based resolver tests. The fixtures mirror what the observer emits
 * for the target app: a textbox with no name, identified by the adjacent cell.
 */

let n = 0;
const node = (p: Partial<UINode> & Pick<UINode, 'role'>): UINode => ({
  ref: ++n, name: '', value: '', states: [], frame: 'main', handle: n, ...p,
});

const obs = (nodes: UINode[]): Observation => ({
  surfaceKind: 'web', capturedAt: new Date().toISOString(),
  frames: [{ id: 'f1', name: 'main' }], nodes, location: 'http://localhost:8710/lookup',
});

const target = (p: unknown) => TargetDescriptor.parse(p);

test('a bare role is not a targetable descriptor', () => {
  assert.throws(() => target({ role: 'button' }), /requires a name or an anchor/);
});

test('resolves by accessible name', () => {
  const r = resolveTarget(obs([node({ role: 'button', name: 'Search' })]), target({ role: 'button', name: 'Search' }));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.via, 'name');
});

test('normalized name matching tolerates case, whitespace and trailing colons', () => {
  const r = resolveTarget(obs([node({ role: 'button', name: 'Member  ID:' })]), target({ role: 'button', name: 'member id' }));
  assert.equal(r.ok, true);
});

test('resolves an ANONYMOUS control by anchor relation — the legacy case', () => {
  const o = obs([
    node({ role: 'text', name: 'Member ID' }),
    node({ role: 'textbox', anchorText: 'Member ID', anchorRelation: 'inSameRowAs' }),
  ]);
  const r = resolveTarget(o, target({
    role: 'textbox', anchor: { relation: 'inSameRowAs', text: 'Member ID' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.via, 'anchor');
  assert.equal(r.ok && r.node.role, 'textbox');
});

test('anchor matching relaxes the relation but never the text', () => {
  // A changed relation with the same text should resolve; a renamed label should not.
  const o = obs([node({ role: 'textbox', anchorText: 'Member ID', anchorRelation: 'labelledBy' })]);
  const ok = resolveTarget(o, target({ role: 'textbox', anchor: { relation: 'inSameRowAs', text: 'Member ID' } }));
  assert.equal(ok.ok, true);

  const renamed = resolveTarget(o, target({ role: 'textbox', anchor: { relation: 'inSameRowAs', text: 'Account Number' } }));
  assert.equal(renamed.ok, false);
  assert.equal(!renamed.ok && renamed.reason, 'not_found');
});

test('AMBIGUITY is a failure, not a first match', () => {
  const o = obs([
    node({ role: 'button', name: 'Select' }),
    node({ role: 'button', name: 'Select' }),
    node({ role: 'button', name: 'Select' }),
  ]);
  const r = resolveTarget(o, target({ role: 'button', name: 'Select' }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'ambiguous');
  assert.equal(!r.ok && r.reason === 'ambiguous' && r.candidates.length, 3);
});

test('an explicit ordinal disambiguates a legitimately repeating control', () => {
  const o = obs([
    node({ role: 'button', name: 'Select' }),
    node({ role: 'button', name: 'Select', value: 'row2' }),
  ]);
  const r = resolveTarget(o, target({ role: 'button', name: 'Select', ordinal: 1 }));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.node.value, 'row2');
});

test('scope confines resolution to a named frame', () => {
  const o = obs([
    node({ role: 'button', name: 'Search', frame: 'hdr' }),
    node({ role: 'button', name: 'Search', frame: 'main' }),
  ]);
  // Unscoped, the same name in two frames is ambiguous.
  assert.equal(resolveTarget(o, target({ role: 'button', name: 'Search' })).ok, false);
  const r = resolveTarget(o, target({ role: 'button', name: 'Search', scope: { frame: 'main' } }));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.node.frame, 'main');
});

test('name is preferred, and anchor carries the target when the name is gone', () => {
  const o = obs([node({ role: 'button', anchorText: 'Actions', anchorRelation: 'inSameRowAs' })]);
  const r = resolveTarget(o, target({
    role: 'button', name: 'Go', anchor: { relation: 'inSameRowAs', text: 'Actions' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.via, 'anchor'); // name tier missed, anchor tier caught it
});

test('reports which tiers were tried when nothing matches', () => {
  const r = resolveTarget(obs([node({ role: 'text', name: 'nope' })]), target({
    role: 'textbox', name: 'Member ID', anchor: { relation: 'inSameRowAs', text: 'Member ID' },
  }));
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.reason === 'not_found' && r.tried, ['name', 'anchor']);
});

test('descriptors interpolate {{param}} so a TARGET can be parameterised', () => {
  // Parameterised target, e.g. "click the row for member {{memberId}}".
  const o = obs([
    node({ role: 'link', name: 'Sarah Chen' }),
    node({ role: 'link', name: 'Marcus Webb' }),
  ]);
  const t = target({ role: 'link', name: '{{memberName}}' });

  const hit = resolveTarget(o, t, { memberName: 'Marcus Webb' });
  assert.equal(hit.ok, true);
  assert.equal(hit.ok && hit.node.name, 'Marcus Webb');

  // Unbound placeholders must not accidentally match anything.
  assert.equal(resolveTarget(o, t, {}).ok, false);
});

test('interpolation reaches anchor text too', () => {
  const o = obs([node({ role: 'cell', anchorText: 'Savings', anchorRelation: 'inSameRowAs' })]);
  const r = resolveTarget(o, target({ role: 'cell', anchor: { relation: 'inSameRowAs', text: '{{accountType}}' } }),
    { accountType: 'Savings' });
  assert.equal(r.ok, true);
});

test('an anchor made of run data is distinguishable from a label', () => {
  // Regression: `wins` anchored to "1990" and `losses` to "44" (data, not labels).
  const isData = (a: string) =>
    a !== '' && (/^[^A-Za-z]*$/.test(a) || /^[$£€]?[\d,.]+%?$/.test(a.trim()));

  for (const bad of ['1990', '44', '$4,182.55', '12,345', '99%', '2026-01-01']) {
    assert.equal(isData(bad), true, `${bad} should read as data`);
  }
  for (const good of ['Wins', 'Member ID', 'Price (incl. tax)', 'Team Name', 'Savings']) {
    assert.equal(isData(good), false, `${good} should read as a label`);
  }
});
