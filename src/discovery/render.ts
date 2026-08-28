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
export function renderObservation(o: Observation): string {
  const out: string[] = [`location: ${o.location}`];
  for (const f of o.frames) {
    const ns = o.nodes.filter((n) => n.frame === f.name);
    if (!ns.length) continue;
    out.push(`\nframe "${f.name}"`);
    for (const n of ns) {
      let line = `  [${n.ref}] ${n.role}`;
      if (n.name) line += ` "${redactText(n.name)}"`;
      if (n.anchorText) line += ` anchored-to="${redactText(n.anchorText)}" (${n.anchorRelation})`;
      if (n.value) line += ` value="${redactText(n.value)}"`;
      if (n.states.length) line += ` [${n.states.join(',')}]`;
      out.push(line);
    }
  }
  return out.join('\n');
}
