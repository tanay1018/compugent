import type { TargetDescriptor, ResolutionTier } from '../schema/target.js';
import type { Observation, ResolveResult, UINode } from './types.js';

/**
 * Target resolution. A pure function of an Observation and a descriptor, so
 * every branch is testable against fixtures without a browser.
 */

/** Normalise labels for comparison ("Member ID:" matches "Member ID"). */
export const norm = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim();

function nameMatches(candidate: string, want: string, mode: TargetDescriptor['nameMatch']): boolean {
  switch (mode) {
    case 'exact':    return candidate === want;
    case 'contains': return norm(candidate).includes(norm(want));
    case 'regex':    try { return new RegExp(want).test(candidate); } catch { return false; }
    case 'normalized':
    default:         return norm(candidate) === norm(want);
  }
}

/** Narrow by frame and containing region before anything else. */
function inScope(node: UINode, target: TargetDescriptor): boolean {
  const s = target.scope;
  if (!s) return true;
  if (s.frame !== undefined && node.frame !== s.frame) return false;
  return true;
}

/**
 * Reduce a candidate set to a verdict. More than one match without an
 * `ordinal` is `ambiguous`, never the first match.
 */
function verdict(cands: UINode[], target: TargetDescriptor, via: ResolutionTier, tried: ResolutionTier[]): ResolveResult | null {
  if (cands.length === 0) return null;
  if (cands.length === 1) return { ok: true, node: cands[0]!, via };
  if (target.ordinal !== undefined) {
    const picked = cands[target.ordinal];
    if (picked) return { ok: true, node: picked, via };
    return { ok: false, reason: 'not_found', tried };
  }
  return { ok: false, reason: 'ambiguous', candidates: cands };
}

/** Interpolate `{{param}}` placeholders into a descriptor (e.g. "the row for {{memberId}}"). */
export function interpolate(t: TargetDescriptor, params: Record<string, unknown>): TargetDescriptor {
  const sub = (v: string): string =>
    v.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (params[k] === undefined ? m : String(params[k])));
  const out: TargetDescriptor = { ...t };
  if (t.name !== undefined) out.name = sub(t.name);
  if (t.anchor) out.anchor = { ...t.anchor, text: sub(t.anchor.text) };
  return out;
}

export function resolveTarget(
  observation: Observation,
  rawTarget: TargetDescriptor,
  params?: Record<string, unknown>,
): ResolveResult {
  const target = params ? interpolate(rawTarget, params) : rawTarget;
  const tried: ResolutionTier[] = [];
  const pool = observation.nodes.filter((n) => n.role === target.role && inScope(n, target));

  // Tier 1 — accessible name. Most precise when the app provides one.
  if (target.name !== undefined) {
    tried.push('name');
    const byName = pool.filter((n) => n.name !== '' && nameMatches(n.name, target.name!, target.nameMatch));
    const v = verdict(byName, target, 'name', tried);
    if (v) return v;
  }

  // Tier 2 — anchor relation. Often the only option on legacy screens.
  if (target.anchor) {
    tried.push('anchor');
    const wantText = norm(target.anchor.text);

    // Strict: anchoring text AND the same relation observed at record time.
    const strict = pool.filter(
      (n) => n.anchorText !== undefined && norm(n.anchorText) === wantText && n.anchorRelation === target.anchor!.relation,
    );
    const v1 = verdict(strict, target, 'anchor', tried);
    if (v1) return v1;

    // Relaxed: same anchoring text, any relation (e.g. a label moved from an
    // adjacent cell into a real <label>).
    const relaxed = pool.filter((n) => n.anchorText !== undefined && norm(n.anchorText) === wantText);
    const v2 = verdict(relaxed, target, 'anchor', tried);
    if (v2) return v2;
  }

  // Tier 3 — recorded fallbacks. Lower confidence; worth reviewing if used.
  for (const fb of target.fallbacks) {
    if (fb.kind === 'text') {
      tried.push('fallback');
      const byText = pool.filter(
        (n) => norm(n.name) === norm(fb.value) || (n.value !== '' && norm(n.value) === norm(fb.value)),
      );
      const v = verdict(byText, target, 'fallback', tried);
      if (v) return v;
    }
    // css / xpath / visual are surface-specific and handled by the Surface
    // implementation, not by this pure resolver.
  }

  return { ok: false, reason: 'not_found', tried };
}
