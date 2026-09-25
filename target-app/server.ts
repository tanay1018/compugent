/**
 * MemberDesk 7.2 — the local target surface.
 *
 * Built like older back-office software: frameset shell, nested tables,
 * <font> tags, no ids or test ids, no <label for>. Label text sits in an
 * adjacent cell, so inputs have no accessible name and must be targeted by
 * anchor.
 *
 * Run: npm run app     (then http://localhost:8710/?tenant=meridian)
 */
import { createServer } from 'node:http';
import { TENANTS, DEFAULT_TENANT, MEMBERS, faultFor, type TenantConfig } from './tenants.js';

const PORT = Number(process.env.TARGET_APP_PORT ?? 8710);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sub-accounts opened in this server's lifetime, per member. */
const subAccounts = new Map<string, Array<{ number: string; type: string }>>();
const SUB_ACCOUNT_TYPES = ['Money Market', 'Share Certificate'];

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

function lookup(t: TenantConfig, error?: string) {
  // L2 replaces the named submit with an unlabelled image input. Chrome then
  // synthesises the name "Submit", which is a browser default rather than app
  // content, so the control also gets a labelled cell to anchor to.
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
    ${error ? `<tr><td colspan="2"><font color="#cc0000" size="2"><b>${error}</b></font></td></tr>` : ''}
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

function detail(t: TenantConfig, id: string, script = '') {
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
</table><br><a href="/lookup?${qs(t)}">New Search</a>
&nbsp;|&nbsp; <a href="/subaccount?${qs(t)}&q1=${encodeURIComponent(id)}">Open Sub-Account</a>${script}`);
}

/** The form behind an irreversible action: opening a sub-account. */
function subAccountForm(t: TenantConfig, id: string) {
  const m = MEMBERS[id]!;
  const existing = subAccounts.get(id) ?? [];
  const rows = existing.length
    ? existing.map((s) => `<tr bgcolor="#ffffff"><td><font size="2">${s.number}</font></td><td><font size="2">${s.type}</font></td></tr>`).join('')
    : `<tr bgcolor="#ffffff"><td colspan="2"><font size="2">None</font></td></tr>`;
  return shell(t, `
<table cellpadding="4" cellspacing="0" border="0" width="100%">
 <tr><td bgcolor="${t.theme.bar}"><font color="#ffffff"><b>Open Sub-Account</b></font></td></tr></table>
<form action="/subaccount/open" method="get">
<input type="hidden" name="tenant" value="${t.id}">
<input type="hidden" name="q1" value="${id}">
<table cellpadding="4" cellspacing="0" border="0">
  <tr><td align="right"><font size="2">Member</font></td><td><b>${m.name}</b> (${id})</td></tr>
  <tr><td align="right"><font size="2">Account Type</font></td>
      <td><select name="type">${SUB_ACCOUNT_TYPES.map((x) => `<option>${x}</option>`).join('')}</select></td></tr>
  <tr><td colspan="2" align="right"><input type="submit" value="Open Account"></td></tr>
</table></form><br>
<table cellpadding="3" cellspacing="1" border="0" bgcolor="#808080">
 <tr bgcolor="#c0c0c0"><td><font size="2"><b>Existing Sub-Account</b></font></td><td><font size="2"><b>Type</b></font></td></tr>
 ${rows}
</table>`);
}

function subAccountOpened(t: TenantConfig, id: string, acct: { number: string; type: string }) {
  return shell(t, `
<table cellpadding="4" cellspacing="0" border="0" width="100%">
 <tr><td bgcolor="${t.theme.bar}"><font color="#ffffff"><b>Sub-Account Opened</b></font></td></tr></table>
<table cellpadding="4" cellspacing="0" border="0">
  <tr><td align="right"><font size="2">Member</font></td><td>${MEMBERS[id]!.name}</td></tr>
  <tr><td align="right"><font size="2">New Account</font></td><td>${acct.number}</td></tr>
  <tr><td align="right"><font size="2">Account Type</font></td><td>${acct.type}</td></tr>
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

    // Sign-in page for the escalation scenario: automation may not enter
    // credentials, so a human does. Also exercises password redaction.
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
      // No alt text, so this control has no author-provided accessible name.
      return send(200, `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="22">
        <rect width="64" height="22" fill="#c0c0c0" stroke="#000"/>
        <text x="32" y="15" font-size="11" text-anchor="middle" font-family="sans-serif">${t.labels.submit}</text></svg>`,
        'image/svg+xml');

    case '/subaccount': {
      const id = u.searchParams.get('q1') ?? '';
      if (!MEMBERS[id]) return send(200, banner(t, '#800000', 'No member found matching that ID.'));
      return send(200, subAccountForm(t, id));
    }

    // Not idempotent on purpose: every request opens another account, which is
    // what makes a repeated submit a real risk.
    case '/subaccount/open': {
      const id = u.searchParams.get('q1') ?? '';
      const type = u.searchParams.get('type') ?? '';
      if (!MEMBERS[id] || !SUB_ACCOUNT_TYPES.includes(type)) {
        return send(400, banner(t, '#800000', 'Invalid sub-account request.'));
      }
      const list = subAccounts.get(id) ?? [];
      const acct = { number: `S-${id}-${String(list.length + 1).padStart(2, '0')}`, type };
      list.push(acct);
      subAccounts.set(id, list);
      return send(200, subAccountOpened(t, id, acct));
    }

    case '/continue':
      return send(200, detail(t, u.searchParams.get('q1') ?? ''));

    case '/detail': {
      const id = (u.searchParams.get('q1') ?? '').trim();
      switch (faultFor(id)) {
        case 'invalid_input':
          return send(200, lookup(t, `${t.labels.memberId} must be exactly 5 digits.`));
        case 'native_dialog':
          return send(200, detail(t, id,
            `<script>alert('This member record is flagged for compliance review. Balances are as of the prior business day.')</script>`));
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
