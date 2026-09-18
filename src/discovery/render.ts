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
    /**
     * What survives truncation.
     *
     * Ranking controls first and letting everything else fall off the end was
     * wrong: OUTPUTS are text and cells, so on a large page the cap discarded
     * precisely the content worth extracting. A Wikipedia infobox -- clean
     * label/value rows, exactly the structure this system targets -- never
     * reached the model, while three hundred navigation links did.
     *
     * Rank is: controls, then ANCHORED content (something names it, so it is
     * addressable and probably an output), then bare prose, which is never a
     * target and never an output.
     */
    const actionable = new Set(['button', 'link', 'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'tab', 'menuitem']);
    const isControl = (n: typeof ns[number]) => actionable.has(n.role);
    const isData    = (n: typeof ns[number]) => !isControl(n) && !!n.anchorText;

    /**
     * Strict ranking still starved one class, it just changed which one.
     *
     * Ranking controls above anchored data means a page with two thousand
     * links spends the whole budget before reaching the first label/value
     * row. On the Bank of America article that is literally what happened:
     * the 39 anchored infobox cells never rendered, and the model -- unable
     * to see ISIN or Industry anywhere on screen -- went looking for them in
     * the EDIT view, clicking into the source editor of a live encyclopedia
     * to read values that were sitting in the page it was already on.
     *
     * So neither class gets to starve the other. Each is guaranteed a share,
     * and whatever one class does not use the other may have. Controls get
     * the larger share because you cannot act on what you cannot see, and
     * being unable to act ends the run; missing one output does not.
     *
     * Within data, cells outrank loose prose: a cell is half of a label/value
     * pair, which is the shape an extractable output actually has.
     */
    const controls = ns.filter(isControl);
    const data     = ns.filter(isData).sort((a, b) => (a.role === 'cell' ? 0 : 1) - (b.role === 'cell' ? 0 : 1));
    const prose    = ns.filter((n) => !isControl(n) && !isData(n));

    const cap = Math.max(budget.left, 0);
    const takeControls = Math.min(controls.length, Math.max(cap - data.length, Math.ceil(cap * 0.55)));
    const takeData     = Math.min(data.length, cap - takeControls);
    const picked = [
      ...controls.slice(0, takeControls),
      ...data.slice(0, takeData),
      ...prose.slice(0, Math.max(cap - takeControls - takeData, 0)),
    ];
    const shown = new Set(picked.map((n) => n.ref));
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
