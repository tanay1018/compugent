import type { ModelMessage } from 'ai';

/**
 * Keep only the most recent observation in full.
 *
 * The agent loop resends the entire conversation on every step, and each step
 * appends a complete rendering of the screen. Input therefore grows
 * quadratically: a five-step run spends ~18K input tokens, most of it
 * re-reading screens that have since been navigated away from.
 *
 * Only the latest observation is decidable-on. Earlier ones are replaced with
 * a one-line note of where the run was, which preserves the narrative — "I was
 * on the lookup screen, then the detail screen" — without paying to re-read
 * either. Cost becomes roughly linear in steps rather than quadratic.
 *
 * This is a bigger lever than model choice: it applies whichever model you
 * point at it, and it compounds with prompt caching rather than competing.
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
      // The opening prompt carries the goal AND the first screen. Keep the
      // goal — it is the whole task — and drop only the screen under it.
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) {
        const cut = text.indexOf('\nCurrent observation:');
        return { ...m, content: cut > 0 ? `${text.slice(0, cut)}\n${stub(text)}` : text } as ModelMessage;
      }
    }
    return m;
  });
}
