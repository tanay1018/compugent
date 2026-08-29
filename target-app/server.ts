/**
 * MemberDesk 7.2 — the local target surface.
 *
 * Intentionally hostile in the way real back-office software is hostile:
 * frameset shell, nested-table layout, <font> tags, no ids, no test ids, no
 * <label for>. Label text sits in an adjacent cell, so the accessibility tree
 * exposes the inputs with NO accessible name. That is the point — it is what
 * forces anchor-relation targeting rather than rewarding a clean selector.
 *
 * Run: npm run app     (then http://localhost:8710/?tenant=meridian)
 */
import { createServer } from 'node:http';
import { TENANTS, DEFAULT_TENANT, MEMBERS, faultFor, type TenantConfig } from './tenants.js';

const PORT = Number(process.env.TARGET_APP_PORT ?? 8710);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Session state, so session-expiry is a real condition rather than a mock. */
const sessions = new Map<string, { expired: boolean }>();
const sessionOf = (id: string) => {
  let s = sessions.get(id);
  if (!s) { s = { expired: false }; sessions.set(id, s); }
  return s;
};

const shell = (t: TenantConfig, body: string) =>
  `<html><head><title>${t.vendorProduct}</title></head><body bgcolor="${t.theme.face}">` +
  `<font face="MS Sans Serif" size="2">${body}</font></body></html>`;

const qs = (t: TenantConfig) => `tenant=${t.id}`;

function header(t: TenantConfig) {
  return shell(t, `
<table width="100%" cellpadding="4" cellspacing="0" border="0"><tr>
  <td bgcolor="${t.theme.bar}"><font color="#ffffff" size="4"><b>${t.vendorProduct.split(' ').slice(1).join(' ')}</b></font></td>
  <td bgcolor="${t.theme.bar}" align="right"><font color="#ffffff">${t.institution} &nbsp;|&nbsp; op: jchen</font></td>
</tr></table>`);
}

function lookup(t: TenantConfig) {
  // L2 replaces the named submit with an unlabelled image input. Note the
  // browser then SYNTHESISES the accessible name "Submit" — author-provided
  // nothing, Chrome-provided default. Targeting that name looks safe and is
  // not: it is a browser-version artefact, not app content. L2 therefore also
  // gives the control a labelled cell so the anchor can carry it instead.
  const submit =
    t.hostility === 'L2'
      ? `<input type="image" src="/img/go.svg" name="go" width="64" height="22">`
      : `<input type="submit" value="${t.labels.submit}">`;
  const submitRow =
    t.hostility === 'L2'
      ? `<tr><td align="right"><font size="2">Action</font></td><td>${submit}</td></tr>`
      : `<tr><td colspan="2" align="right">${submit}</td></tr>`;
  const sel = (v: string) => (t.defaultSearchType === v ? ' selected' : '');
  return shell(t, `
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td>
 <table cellpadding="6" cellspacing="0" border="0"><tr><td>
  <table cellpadding="3" cellspacing="1" border="0" bgcolor="#808080"><tr><td bgcolor="${t.theme.face}">
   <table cellpadding="4" cellspacing="0" border="0">
    <tr><td colspan="2" bgcolor="${t.theme.bar}"><font color="#ffffff"><b>${t.labels.panel}</b></font></td></tr>
    <form action="/detail" method="get">
    <input type="hidden" name="tenant" value="${t.id}">
    <tr><td align="right"><font size="2">${t.labels.memberId}</font></td>
        <td><input type="text" name="q1" size="18"></td></tr>
    <tr><td align="right"><font size="2">${t.labels.searchType}</font></td>
        <td><select name="q2">
          <option value="M"${sel('M')}>Member Number</option>
          <option value="S"${sel('S')}>SSN (last 4)</option>
        </select></td></tr>
    ${submitRow}
    </form>
   </table>
  </td></tr></table>
 </td></tr></table>
</td></tr></table>`);
}

const banner = (t: TenantConfig, colour: string, msg: string, back = true) =>
  shell(t, `<table cellpadding="6"><tr><td bgcolor="#ffffcc">
  <font color="${colour}"><b>${msg}</b></font></td></tr></table>` +
  (back ? `<br><a href="/lookup?${qs(t)}">Return to ${t.labels.panel}</a>` : ''));

function detail(t: TenantConfig, id: string) {
  const m = MEMBERS[id]!;
  return shell(t, `
<table cellpadding="4" cellspacing="0" border="0" width="100%">
 <tr><td bgcolor="${t.theme.bar}"><font color="#ffffff"><b>Member Detail</b></font></td></tr></table>
<table cellpadding="4" cellspacing="0" border="0">
  <tr><td align="right"><font size="2">Name</font></td><td><b>${m.name}</b></td></tr>
  <tr><td align="right"><font size="2">${t.labels.memberId}</font></td><td>${id}</td></tr>
  <tr><td align="right"><font size="2">Status</font></td><td>${m.status}</td></tr>
</table><br>
<table cellpadding="3" cellspacing="1" border="0" bgcolor="#808080">
 <tr bgcolor="#c0c0c0"><td><font size="2"><b>Account</b></font></td><td><font size="2"><b>Balance</b></font></td></tr>
 <tr bgcolor="#ffffff"><td><font size="2">Savings</font></td><td align="right"><font size="2">$${m.savings}</font></td></tr>
 <tr bgcolor="#ffffff"><td><font size="2">Checking</font></td><td align="right"><font size="2">$${m.checking}</font></td></tr>
</table><br><a href="/lookup?${qs(t)}">New Search</a>`);
}

createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const t = TENANTS[u.searchParams.get('tenant') ?? DEFAULT_TENANT] ?? TENANTS[DEFAULT_TENANT]!;
  const sid = u.searchParams.get('sid') ?? 'default';
  const send = (code: number, body: string, type = 'text/html') => {
    res.writeHead(code, { 'Content-Type': type }); res.end(body);
  };

  switch (u.pathname) {
    case '/':
      return send(200, `<html><head><title>${t.vendorProduct}</title></head>
<frameset rows="72,*" border="1">
  <frame name="hdr" src="/hdr?${qs(t)}" scrolling="no">
  <frame name="main" src="/lookup?${qs(t)}">
</frameset></html>`);

    case '/hdr':   return send(200, header(t));

    // Re-authentication exists so the escalation demo has a real resolution:
    // automation is not permitted to handle credentials, so a human must do
    // this. The password field is here to exercise redaction -- its value must
    // never reach the event log.
    case '/login':
      return send(200, shell(t, `
<table cellpadding="6" cellspacing="1" bgcolor="#808080"><tr><td bgcolor="${t.theme.face}">
 <table cellpadding="4">
  <tr><td colspan="2" bgcolor="${t.theme.bar}"><font color="#ffffff"><b>Sign In</b></font></td></tr>
  <form action="/signin" method="get">
  <input type="hidden" name="tenant" value="${t.id}">
  <tr><td align="right"><font size="2">Operator ID</font></td><td><input type="text" name="op" size="16"></td></tr>
  <tr><td align="right"><font size="2">Password</font></td><td><input type="password" name="pw" size="16"></td></tr>
  <tr><td colspan="2" align="right"><input type="submit" value="Sign In"></td></tr>
  </form>
 </table></td></tr></table>`));

    case '/signin':
      sessionOf(sid).expired = false;
      return send(200, lookup(t));
    case '/lookup':
      if (sessionOf(sid).expired) return send(200, shell(t, `<table cellpadding="6"><tr><td bgcolor="#ffffcc">
  <font color="#800000"><b>Your session has expired. Please sign in again.</b></font></td></tr></table>
<br><a href="/login?${qs(t)}">Sign In</a>`));
      return send(200, lookup(t));

    case '/img/go.svg':
      // No alt text is available on an <input type="image">'s SVG source, so
      // this control is anonymous in the a11y tree by construction.
      return send(200, `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="22">
        <rect width="64" height="22" fill="#c0c0c0" stroke="#000"/>
        <text x="32" y="15" font-size="11" text-anchor="middle" font-family="sans-serif">${t.labels.submit}</text></svg>`,
        'image/svg+xml');

    case '/continue':
      return send(200, detail(t, u.searchParams.get('q1') ?? ''));

    case '/detail': {
      const id = (u.searchParams.get('q1') ?? '').trim();
      switch (faultFor(id)) {
        case 'slow':
          await sleep(8000);
          return send(200, detail(t, id));      // the RIGHT member, just late
        case 'wrong_record':
          return send(200, detail(t, '12345')); // a valid screen, wrong member
        case 'not_found':
          return send(200, banner(t, '#800000', 'No member found matching that ID.'));
        case 'permission_denied':
          return send(200, banner(t, '#800000', 'You are not authorized to view this member record.'));
        case 'server_error':
          return send(500, banner(t, '#800000', 'MemberDesk error 0x5F: unable to complete request.', false));
        case 'session_expired':
          sessionOf(sid).expired = true;
          return send(200, shell(t, `<table cellpadding="6"><tr><td bgcolor="#ffffcc">
  <font color="#800000"><b>Your session has expired. Please sign in again.</b></font></td></tr></table>
<br><a href="/login?${qs(t)}">Sign In</a>`));
        case 'interstitial':
          return send(200, shell(t, `
<table cellpadding="8" cellspacing="1" bgcolor="#808080"><tr><td bgcolor="${t.theme.face}">
 <table cellpadding="4"><tr><td colspan="2" bgcolor="${t.theme.bar}"><font color="#ffffff"><b>Session Notice</b></font></td></tr>
 <tr><td colspan="2"><font size="2">Scheduled maintenance begins at 23:00 ET.</font></td></tr>
 <tr><td colspan="2" align="right"><a href="/continue?${qs(t)}&q1=${encodeURIComponent(id)}">Continue</a></td></tr>
 </table></td></tr></table>`));
        case 'none':
          return send(200, detail(t, id));
      }
    }
  }
  return send(404, '<h1>404</h1>');
}).listen(PORT, () => {
  console.log(`MemberDesk 7.2 → http://localhost:${PORT}/`);
  for (const t of Object.values(TENANTS))
    console.log(`  ${t.institution.padEnd(28)} ${t.hostility}  http://localhost:${PORT}/?tenant=${t.id}`);
});
