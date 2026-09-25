/**
 * Learn this capability's outcome signatures from runs that actually produce
 * them, and publish the result as a new artifact version.
 *
 *   npm run learn-outcomes -- member.readSavingsBalance
 *
 * The classifications below are written by hand; only the wording is learned.
 */
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { ArtifactStore } from '../src/store/artifacts.js';
import { learnOutcomes, type OutcomeProbe } from '../src/replay/learn.js';
import { CapabilityArtifact } from '../src/schema/artifact.js';

const id = process.argv[2] ?? 'member.readSavingsBalance';
const port = process.env.TARGET_APP_PORT ?? '8710';
const baseUrl = process.argv[3] ?? `http://localhost:${port}/?tenant=meridian`;

const PROBES: OutcomeProbe[] = [
  { name: 'member_not_found', classification: 'business_outcome', inputs: { memberId: '99999' },
    message: 'No member matches that identifier.' },
  { name: 'permission_denied', classification: 'business_outcome', inputs: { memberId: '40003' },
    message: 'The operator is not authorised to view this member record.' },
  { name: 'maintenance_notice', classification: 'recoverable', inputs: { memberId: '40002' },
    message: 'A scheduled-maintenance interstitial was dismissed.', recoverBy: 'dismissNewControl' },
  { name: 'application_error', classification: 'hard_failure', inputs: { memberId: '40004' },
    message: 'The application returned an internal error.' },
  { name: 'invalid_member_id', classification: 'business_outcome', inputs: { memberId: 'ABC12' },
    message: 'The member ID failed the form\'s validation: it must be exactly 5 digits.' },
  { name: 'compliance_alert', classification: 'recoverable', inputs: { memberId: '40007' },
    message: 'A native compliance alert was acknowledged before the detail screen.', recoverBy: 'dismissNewControl' },
  // Last: it leaves the target app's session expired for every later run.
  { name: 'session_expired', classification: 'escalate', inputs: { memberId: '40005' },
    message: 'The session expired. Automation cannot re-authenticate; a human must sign in.' },
];

const store = new ArtifactStore();
const current = store.load(id);
const surface = await PlaywrightSurface.launch();

try {
  console.log(`learning outcomes for ${current.id} v${current.version}\n`);
  const outcomes = await learnOutcomes(current, PROBES, surface, baseUrl, { memberId: '12345' },
    (m) => console.log(m));

  // The next free version: `current` is the approved one, which need not be the newest.
  const version = store.nextVersion(id);
  const next = CapabilityArtifact.parse({
    ...current,
    version,
    approval: 'draft',
    outcomes,
    provenance: {
      ...current.provenance,
      warnings: [...current.provenance.warnings,
        `v${version}: ${outcomes.length} outcome signatures learned from probe runs (based on v${current.version})`],
    },
  });
  const path = store.save(next);
  console.log(`\n${outcomes.length} outcomes learned -> ${path}`);
  console.log(`\n  ${'OUTCOME'.padEnd(20)} ${'CLASS'.padEnd(17)} DETECTED BY`);
  for (const o of next.outcomes) {
    const t = o.detect.kind === 'textPresent' ? `"${o.detect.text}"` : o.detect.kind;
    console.log(`  ${o.name.padEnd(20)} ${o.classification.padEnd(17)} ${t}`);
    if (o.recovery) console.log(`  ${''.padEnd(38)} recovery: ${o.recovery.kind}`);
  }
  console.log('');
} finally {
  await surface.close();
}
