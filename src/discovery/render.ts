import type { Observation } from '../surface/types.js';
import { redactText } from '../policy/allowlist.js';

/**
 * Render an observation for the model.
 *
 * The model never sees HTML. It sees this. Two consequences worth stating:
 *
 *  - It costs roughly an order of magnitude fewer tokens than raw markup and is
 *    stable against the cosmetic churn that dominates a real DOM diff.
 *  - It teaches the model the SAME targeting vocabulary the replay resolver
 *    uses. When the model picks "the textbox anchored to Member ID", that is
 *    already a TargetDescriptor — so compilation is mechanical rather than an
 *    exercise in parsing a transcript back into intent.
 */
/**
 * Upper bound on how much of a screen is worth describing.
 *
 * A content-heavy page can expose hundreds of nodes -- books.toscrape.com
 * renders 402, Wikipedia 1393 -- and at roughly 15 tokens a line that is
 * thousands of tokens per observation, resent on every step. Controls and
 * labelled content come first; the tail of a long list rarely decides
 * anything, and the model is told when it has been cut so it can scroll or
 * narrow rather than assume it saw everything.
 */
const MAX_NODES = Number(process.env.MAX_OBSERVATION_NODES ?? 140);

export function renderObservation(o: Observation): string {
  const out: string[] = [`location: ${o.location}`];
  const budget = { left: MAX_NODES, dropped: 0 };
  for (const f of o.frames) {
    const ns = o.nodes.filter((n) => n.frame === f.name);
    if (!ns.length) continue;
    out.push(`\nframe "${f.name}"`);
    // Actionable controls are never dropped; long runs of text are.
    const actionable = new Set(['button', 'link', 'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'tab', 'menuitem']);
    const ranked = [...ns].sort((a, b) => Number(actionable.has(b.role)) - Number(actionable.has(a.role)));
    const shown = new Set(ranked.slice(0, Math.max(budget.left, 0)).map((n) => n.ref));
    budget.left -= shown.size;
    budget.dropped += ns.length - shown.size;
    for (const n of ns) {
      if (!shown.has(n.ref)) continue;
      let line = `  [${n.ref}] ${n.role}`;
      if (n.name) line += ` "${redactText(n.name)}"`;
      if (n.anchorText) line += ` anchored-to="${redactText(n.anchorText)}" (${n.anchorRelation})`;
      if (n.value) line += ` value="${redactText(n.value)}"`;
      if (n.states.length) line += ` [${n.states.join(',')}]`;
      out.push(line);
    }
  }
  if (budget.dropped > 0) {
    out.push(`\n(${budget.dropped} further node(s) not shown — this screen is larger than the view. ` +
             `Narrow the page or scroll if what you need is missing.)`);
  }
  return out.join('\n');
}
