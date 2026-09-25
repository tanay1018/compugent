/**
 * MemberDesk 7.2 — a fictional back-office product by fictional vendor
 * "Corelink", used here as a stand-in for the real thing.
 *
 * Two tenants run the same product with different configuration, branding and
 * version. The same settings control how hard the UI is to automate:
 *
 *   L0  semantic markup, real <label for> — the "modern web app" case
 *   L1  frameset + nested tables, no test ids, labels only positionally
 *       adjacent, so the a11y tree exposes inputs with NO accessible name
 *   L2  L1 plus image submit buttons with no alt text, so the *button* is
 *       anonymous too and anchor relations must carry the whole flow
 */
export type Hostility = 'L0' | 'L1' | 'L2';

export interface TenantConfig {
  id: string;
  institution: string;
  vendorProduct: string;
  hostility: Hostility;
  /** Per-tenant wording: same field, different label. */
  labels: { memberId: string; searchType: string; submit: string; panel: string };
  theme: { bar: string; face: string };
  /** Default of the search-type control. A different default changes what an artifact does (REPORT.md §4.5). */
  defaultSearchType: 'M' | 'S';
}

export const TENANTS: Record<string, TenantConfig> = {
  meridian: {
    id: 'meridian',
    institution: 'Meridian Credit Union',
    vendorProduct: 'Corelink MemberDesk 7.2',
    hostility: 'L1',
    labels: { memberId: 'Member ID', searchType: 'Search Type', submit: 'Search', panel: 'Member Inquiry' },
    theme: { bar: '#000080', face: '#d4d0c8' },
    defaultSearchType: 'M',
  },
  harbor: {
    id: 'harbor',
    institution: 'Harbor Point Federal CU',
    vendorProduct: 'Corelink MemberDesk 7.1',
    hostility: 'L2',
    labels: { memberId: 'Account Number', searchType: 'Lookup By', submit: 'Go', panel: 'Account Inquiry' },
    theme: { bar: '#004d4d', face: '#cfd8d8' },
    defaultSearchType: 'M',
  },
};

export const DEFAULT_TENANT = 'meridian';

export interface MemberRecord {
  name: string; status: string; savings: string; checking: string;
}

export const MEMBERS: Record<string, MemberRecord> = {
  '12345': { name: 'Sarah Chen',  status: 'Active',     savings: '4,182.55',  checking: '1,204.10' },
  '67890': { name: 'Marcus Webb', status: 'Active',     savings: '812.30',    checking: '95.00' },
  '55501': { name: 'Dana Ortiz',  status: 'Restricted', savings: '15,900.00', checking: '3,410.75' },
  // Real members whose lookup triggers a fault, so each fault tests one thing.
  '40001': { name: 'Ivan Petrov',  status: 'Active',     savings: '229.14',    checking: '18.60' },
  '40002': { name: 'Priya Raman',  status: 'Active',     savings: '7,020.00',  checking: '640.25' },
};

/**
 * Fault injection keyed on the input, so every evidence run is reproducible
 * without an admin panel. Each code maps onto one tier of the error taxonomy.
 */
export type Fault =
  | 'none' | 'not_found' | 'slow' | 'interstitial'
  | 'permission_denied' | 'server_error' | 'session_expired' | 'wrong_record';

export const FAULTS: Record<string, Fault> = {
  '99999': 'not_found',          // expected BUSINESS OUTCOME — not a crash
  '40001': 'slow',               // RECOVERABLE — wait / retry
  '40002': 'interstitial',       // RECOVERABLE — dismiss a known dialog
  '40003': 'permission_denied',  // expected BUSINESS OUTCOME
  '40004': 'server_error',       // HARD FAILURE — stop, surface, debug
  '40005': 'session_expired',    // ESCALATE — automation cannot re-authenticate
  // Renders a valid detail screen for the wrong member. The checkpoint passes;
  // only mustMatchParam catches it.
  '40006': 'wrong_record',
};

export const faultFor = (id: string): Fault =>
  FAULTS[id] ?? (MEMBERS[id] ? 'none' : 'not_found');
