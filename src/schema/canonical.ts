/**
 * Turn a concrete location into a pattern.
 *
 * A recorded run visits `/detail?q1=12345&q2=M`. Storing that verbatim would
 * bake one member into the artifact and make every waypoint fail for everyone
 * else. Canonicalisation is what lets a location be asserted at all:
 *
 *   /detail?q1=12345&q2=M   ->   ^/detail(\?|$)
 *   /member/12345/accounts  ->   ^/member/[^/]+/accounts$
 *
 * The same normalisation is the first half of cross-tenant reuse: two tenants
 * on one vendor product differ in host and often in a path prefix, never in
 * the shape of the route.
 */
export function canonicaliseLocation(raw: string): { pattern: string; path: string } {
  let path: string;
  try {
    path = new URL(raw).pathname;
  } catch {
    path = raw;
  }

  // Path segments that are plainly identifiers rather than route names.
  const segs = path.split('/').map((s) => {
    if (s === '') return s;
    if (/^\d+$/.test(s)) return '[^/]+';                       // numeric id
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return '[^/]+';  // uuid
    if (/^[A-Za-z]*\d{4,}$/.test(s)) return '[^/]+';           // ACC0012345
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });

  const normalised = segs.join('/');
  // Query values are never part of the identity of a screen — only the route
  // is. Asserting on them would re-introduce the run's data.
  return { pattern: `^${normalised}(\\?|$)`, path };
}
