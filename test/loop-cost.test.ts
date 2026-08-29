import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { compactObservations } from '../src/discovery/compact.js';
import type { ModelMessage } from 'ai';

/**
 * Does a `messages` override from prepareStep actually reach the model?
 *
 * compactObservations is unit-tested in isolation, but that proves nothing
 * about the wiring — and the gateway's request log showed 40K-token inputs,
 * which is what an UNcompacted multi-step run looks like. A mock model settles
 * it for free.
 */
function spy() {
  const seen: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: (async ({ prompt }: { prompt: unknown }) => {
      seen.push(JSON.stringify(prompt));
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      };
    }) as never,
  });
  return { model, seen };
}

test('prepareStep can rewrite the messages the model receives', async () => {
  const { model, seen } = spy();
  await generateText({
    model,
    messages: [{ role: 'user', content: 'ORIGINAL TEXT' }],
    prepareStep: () => ({ messages: [{ role: 'user', content: 'REWRITTEN TEXT' }] as ModelMessage[] }),
  });
  assert.ok(seen[0]!.includes('REWRITTEN TEXT'), 'the override must reach the model');
  assert.ok(!seen[0]!.includes('ORIGINAL TEXT'), 'the original must not');
});

test('compaction shrinks what the model receives', async () => {
  const OBS = (loc: string) =>
    `location: ${loc}\n\nframe "main"\n` +
    Array.from({ length: 40 }, (_, i) => `  [${i}] text "row ${i} — a column label and its value"`).join('\n');

  // A conversation the way it looks six steps into a run.
  const history: ModelMessage[] = [{ role: 'user', content: `GOAL: read a balance\n\nCurrent observation:\n${OBS('/entry')}` }];
  for (let i = 0; i < 5; i++) {
    history.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'look', input: {} }] } as ModelMessage);
    history.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'look',
      output: { type: 'text', value: `OK.\n\n${OBS(`/screen${i}`)}` } }] } as ModelMessage);
  }

  const plain = spy();
  await generateText({ model: plain.model, messages: history });

  const compacted = spy();
  await generateText({
    model: compacted.model, messages: history,
    prepareStep: ({ messages }) => ({ messages: compactObservations(messages) }),
  });

  const before = plain.seen[0]!.length;
  const after = compacted.seen[0]!.length;
  const saved = Math.round(100 - (100 * after) / before);
  console.log(`      what the model receives: ${before} -> ${after} chars (${saved}% smaller)`);
  assert.ok(saved > 60, `expected a large reduction at the model boundary, got ${saved}%`);
});
