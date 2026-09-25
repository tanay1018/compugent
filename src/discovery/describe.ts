import { TargetDescriptor } from '../schema/target.js';
import type { Observation, UINode } from '../surface/types.js';
import { resolveTarget } from '../surface/resolve.js';

/**
 * Turn an observed node into a persistable TargetDescriptor.
 *
 * The model picks a node by an ephemeral ref, so before a step is recorded it
 * is re-expressed as a description that can find the same control on a fresh
 * page.
 */

export type Purpose = 'action' | 'extraction';

export interface Described {
  descriptor: TargetDescriptor;
  verified: boolean;
  problem?: string;
}

/**
 * Each descriptor is verified against the observation it came from: it must
 * resolve back to exactly the intended node. Catching this at record time is
 * much cheaper than at replay.
 */
export function describeNode(observation: Observation, node: UINode, purpose: Purpose = 'action'): Described {
  const base = {
    role: node.role,
    scope: { frame: node.frame },
    provenance: { discoveredAt: new Date().toISOString() },
  };

  const anchor = node.anchorText
    ? { relation: (node.anchorRelation ?? 'precededBy') as never, text: node.anchorText }
    : undefined;

  const attempts: TargetDescriptor[] = [];

  // Extraction targets are anchor-only: the node's name is the value being
  // read ("$4,182.55"), not its identity.
  if (purpose === 'extraction') {
    if (anchor) attempts.push(TargetDescriptor.parse({ ...base, anchor }));
  } else {
    if (node.name && anchor) attempts.push(TargetDescriptor.parse({ ...base, name: node.name, anchor }));
    if (node.name) attempts.push(TargetDescriptor.parse({ ...base, name: node.name }));
    if (anchor) attempts.push(TargetDescriptor.parse({ ...base, anchor }));
  }

  for (const d of attempts) {
    const r = resolveTarget(observation, d);
    if (r.ok && r.node.ref === node.ref) return { descriptor: d, verified: true };

    // At record time an ambiguous match can be fixed with an ordinal, since we
    // know which candidate was meant. The ordinal indexes the matching
    // candidates (what resolveTarget applies it to), not all same-role nodes.
    if (!r.ok && r.reason === 'ambiguous') {
      const idx = r.candidates.findIndex((c) => c.ref === node.ref);
      if (idx >= 0) {
        const withOrdinal = TargetDescriptor.parse({ ...d, ordinal: idx });
        const rr = resolveTarget(observation, withOrdinal);
        if (rr.ok && rr.node.ref === node.ref) {
          return {
            descriptor: withOrdinal,
            verified: true,
            // Positional, so fragile if the page reorders; flagged for review.
            problem: `not unique — disambiguated by ordinal ${idx} of ${r.candidates.length} matching ${node.role} nodes`,
          };
        }
      }
    }
  }

  const first = attempts[0];

  return {
    descriptor: first ?? TargetDescriptor.parse({ ...base, name: node.name || '(unnamed)' }),
    verified: false,
    problem:
      purpose === 'extraction'
        ? 'extraction target has no anchor; its value cannot be relocated on a fresh page'
        : 'no descriptor resolves uniquely back to this node',
  };
}
