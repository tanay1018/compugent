import type { Observation } from '../surface/types.js';
import { redactText } from '../policy/allowlist.js';

/**
 * Render an observation for the model, in place of HTML.
 *
 * Much smaller than markup, and it uses the same targeting vocabulary as the
 * resolver: when the model picks "the textbox anchored to Member ID", that is
 * already a TargetDescriptor.
 *
 * Output is capped at MAX_OBSERVATION_NODES (large pages expose 400-1400
 * nodes, resent every step). The model is told when the list was cut.
 */
const MAX_NODES = Number(process.env.MAX_OBSERVATION_NODES ?? 140);

export function renderObservation(o: Observation): string {
  const out: string[] = [`location: ${o.location}`];
  const budget = { left: MAX_NODES, dropped: 0 };
  for (const f of o.frames) {
    const ns = o.nodes.filter((n) => n.frame === f.name);
    if (!ns.length) continue;
    out.push(`\nframe "${f.name}"`);
    // Rank for truncation: controls, then anchored content (likely outputs),
    // then bare prose.
    const actionable = new Set(['button', 'link', 'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'tab', 'menuitem']);
    const isControl = (n: typeof ns[number]) => actionable.has(n.role);
    const isData    = (n: typeof ns[number]) => !isControl(n) && !!n.anchorText;

    /**
     * Controls and data each get a reserved share of the budget, and either
     * may use what the other leaves. With strict ranking, the ~2000 links on
     * the Bank of America article used the whole budget and no infobox cell
     * was rendered. Controls get the larger share, since not being able to act
     * ends the run. Within data, cells rank above loose prose.
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
