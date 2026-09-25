import type { ModelMessage } from 'ai';

/**
 * Keep only the most recent observation in full.
 *
 * The loop resends the whole conversation each step, and each step adds a
 * full screen rendering, so input grows quadratically (~18K tokens for five
 * steps). Earlier observations are replaced with a one-line note of where the
 * run was, making cost roughly linear in steps.
 *
 * Because history is rewritten every step, this prevents prompt caching of
 * anything beyond the system prompt.
 */
const OBSERVATION_MARKER = 'location: ';

const stub = (text: string): string => {
  const loc = /location: (\S+)/.exec(text)?.[1] ?? 'an earlier screen';
  return `OK. (was at ${loc} — screen detail omitted, it is no longer current)`;
};

const carriesObservation = (m: ModelMessage): boolean => {
  if (m.role === 'tool' && Array.isArray(m.content)) {
    return m.content.some((p) => {
      const v = (p as { output?: { value?: unknown } }).output?.value;
      return typeof v === 'string' && v.includes(OBSERVATION_MARKER);
    });
  }
  if (m.role === 'user') {
    const c = m.content;
    if (typeof c === 'string') return c.includes(OBSERVATION_MARKER);
    if (Array.isArray(c)) return c.some((p) => (p as { text?: string }).text?.includes(OBSERVATION_MARKER) ?? false);
  }
  return false;
};

export function compactObservations(messages: ModelMessage[]): ModelMessage[] {
  const carrying = messages.map((m, i) => (carriesObservation(m) ? i : -1)).filter((i) => i >= 0);
  // Nothing to save until at least one observation has gone stale.
  if (carrying.length <= 1) return messages;
  const newest = carrying[carrying.length - 1];

  return messages.map((m, i) => {
    if (i === newest || !carrying.includes(i)) return m;

    if (m.role === 'tool' && Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((p) => {
          const part = p as { output?: { value?: unknown } };
          const v = part.output?.value;
          if (typeof v !== 'string' || !v.includes(OBSERVATION_MARKER)) return p;
          return { ...part, output: { type: 'text', value: stub(v) } };
        }),
      } as ModelMessage;
    }

    if (m.role === 'user') {
      // The first message has the goal and the first screen; keep the goal.
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) {
        const cut = text.indexOf('\nCurrent observation:');
        return { ...m, content: cut > 0 ? `${text.slice(0, cut)}\n${stub(text)}` : text } as ModelMessage;
      }
    }
    return m;
  });
}
