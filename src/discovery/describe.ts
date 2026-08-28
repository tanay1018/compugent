import { TargetDescriptor } from '../schema/target.js';
import type { Observation, UINode } from '../surface/types.js';
import { resolveTarget } from '../surface/resolve.js';

/**
 * Turn an observed node into a persistable TargetDescriptor.
 *
 * This is the hinge between discovery and replay. The model picks a node by an
 * ephemeral ref; that ref is meaningless five seconds later, so before a step
 * is recorded it must be re-expressed as a description that can find the same
 * control again on a fresh page.
 */

export type Purpose = 'action' | 'extraction';

export interface Described {
  descriptor: TargetDescriptor;
  verified: boolean;
  problem?: string;
}

/**
 * Descriptors are synthesised and then IMMEDIATELY VERIFIED against the
 * observation they came from: does this description resolve back to exactly
 * the node we meant?
 *
 * Catching an under-specified descriptor here — at record time, with the page
 * still in front of us — is far cheaper than discovering at replay that it
 * matches three controls. A recorder that skips this check produces artifacts
 * that fail in production for reasons nobody can reconstruct.
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

  /**
   * For an EXTRACTION target the accessible name is the data we came to read —
   * "$4,182.55" is this member's balance, not the field's identity. Recording
   * it would pin the artifact to one member. Extraction targets are therefore
   * anchor-only, by construction.
   */
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

    // Ambiguous is recoverable at RECORD time in a way it never is at replay
    // time: we can see which of the candidates the model actually meant.
    //
    // The ordinal must index the MATCHING CANDIDATES, not all same-role nodes
    // in the frame — that is the population resolveTarget applies it to. An
    // earlier version counted siblings, so the ordinal never verified and
    // descriptors shipped ambiguous. The failure surfaced on a product grid
    // where every tile carries two identically-named links (thumbnail and
    // title), which is the norm on real listings and never happened on a
    // hand-built form.
    if (!r.ok && r.reason === 'ambiguous') {
      const idx = r.candidates.findIndex((c) => c.ref === node.ref);
      if (idx >= 0) {
        const withOrdinal = TargetDescriptor.parse({ ...d, ordinal: idx });
        const rr = resolveTarget(observation, withOrdinal);
        if (rr.ok && rr.node.ref === node.ref) {
          return {
            descriptor: withOrdinal,
            verified: true,
            // Positional, so it is fragile if the page ever reorders. Flagged
            // rather than hidden: the step carries this into review.
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
