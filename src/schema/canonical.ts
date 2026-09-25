/**
 * Turn a concrete location into a pattern.
 *
 * Storing a visited URL verbatim would tie the artifact to one record, so
 * identifiers and query values are removed:
 *
 *   /detail?q1=12345&q2=M   ->   ^/detail(\?|$)
 *   /member/12345/accounts  ->   ^/member/[^/]+/accounts$
 *
 * Tenants on the same product differ in host (and sometimes path prefix), not
 * in route shape, so this also supports reuse across tenants.
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
  // Query values are run data, not part of the screen's identity.
  return { pattern: `^${normalised}(\\?|$)`, path };
}
