import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The central claim of the whole system is that replay runs WITHOUT a model in
 * the decision loop. That claim is worth more as a build-time guarantee than as
 * a sentence in a README, so it is asserted structurally: nothing reachable
 * from the replay engine may import an LLM SDK.
 */
const MODEL_IMPORTS = [/from ['"]ai['"]/, /@ai-sdk/, /gateway\(/, /generateText|generateObject/];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

test('the replay path never imports a model SDK', () => {
  // learn.ts is a compile-time authoring tool, not part of the invocation path.
  const files = walk('src/replay').filter((f) => !f.endsWith('learn.ts'));
  assert.ok(files.length >= 2, 'expected replay sources to exist');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of MODEL_IMPORTS) {
      assert.ok(!re.test(src), `${f} references ${re} — replay must not invoke a model`);
    }
  }
});

test('the surface and schema layers are model-free too', () => {
  for (const dir of ['src/surface', 'src/schema', 'src/policy', 'src/store']) {
    for (const f of walk(dir)) {
      const src = readFileSync(f, 'utf8');
      for (const re of MODEL_IMPORTS) {
        assert.ok(!re.test(src), `${f} references ${re}`);
      }
    }
  }
});
