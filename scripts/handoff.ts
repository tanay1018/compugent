/**
 * The escalation → takeover → resume loop, end to end.
 *
 *   npm run handoff                  # opens a real console and waits for you
 *   npm run handoff -- --simulate    # a scripted operator, for reproducible evidence
 *
 * Scenario: the lookup hits an expired session. Automation may not enter
 * credentials, so it escalates. A human signs in on the same session and hands
 * back, and replay re-localises and finishes.
 */
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { ArtifactStore } from '../src/store/artifacts.js';
import { defaultPolicy } from '../src/policy/allowlist.js';
import { RunLog } from '../src/run/log.js';
import { replay } from '../src/replay/engine.js';
import { HandoffSession } from '../src/hitl/session.js';
import { OperatorConsole } from '../src/hitl/console.js';
import { localize, planReentry } from '../src/hitl/relocalize.js';

const simulate = process.argv.includes('--simulate');
const port = process.env.TARGET_APP_PORT ?? '8710';
const baseUrl = `http://localhost:${port}/?tenant=meridian`;
const artifact = new ArtifactStore().load('member.readSavingsBalance');
const log = new RunLog('evidence', `handoff-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const surface = await PlaywrightSurface.launch();
const session = new HandoffSession(surface, log);
const consoleSrv = new OperatorConsole(session, log, 8790);
const rule = (t: string) => console.log(`\n\x1b[1m── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}\x1b[0m`);

try {
  await session.prepare();   // install operator capture before any navigation

  rule('1. REPLAY — runs until it cannot safely continue');
  const first = await replay({
    artifact, inputs: { memberId: '40005' }, surface,
    policy: defaultPolicy(new URL(baseUrl).origin), log, baseUrl,
  });
  console.log(`   status: ${first.status.toUpperCase()}`);
  if (first.status !== 'escalated') { console.log('   (expected an escalation)'); process.exit(1); }
  console.log(`   reason: ${first.reason}`);

  rule('2. ESCALATION — routed with enough context to act on');
  const ctx = await session.escalate({
    reason: first.reason, capability: `${artifact.id} v${artifact.version}`,
    ...(first.atStep !== undefined ? { atStep: first.atStep } : {}),
  });
  const url = await consoleSrv.start();
  console.log(`   console : ${url}`);
  console.log(`   control : ${session.control.state} (holder: ${session.control.holder})`);
  console.log(`   context : ${ctx.location}`);

  rule('3. TAKEOVER — a human drives THE SAME session');
  if (simulate) {
    // The scripted operator uses the same path as a real one: control token,
    // then forwarded raw input.
    // Escalating already raised the request, so only ask if it has not been.
    if (session.control.state === 'agent') session.control.requestPause('scripted operator taking control');
    session.yield();
    console.log(`   control : ${session.control.state} (holder: ${session.control.holder})`);

    const ACTIONABLE = new Set(['textbox', 'button', 'link', 'combobox']);
    const click = async (label: string) => {
      const o = await surface.observe();
      // Prefer the control over its label text; both carry "Operator ID".
      const n = o.nodes.find((x) => ACTIONABLE.has(x.role) && (x.name === label || x.anchorText === label));
      if (!n) throw new Error(`operator could not find a control for "${label}" at ${o.location}`);
      const b = await surface.boundsOf(n);
      await session.operatorInput({ type: 'mouse', action: 'down', x: b.x, y: b.y });
      await session.operatorInput({ type: 'mouse', action: 'up', x: b.x, y: b.y });
      await surface.waitForStable();
    };
    await click('Sign In');                       // the link on the expiry notice
    await click('Operator ID');
    await session.operatorInput({ type: 'text', text: 'jchen' });
    await click('Password');
    await session.operatorInput({ type: 'text', text: 'not-a-real-password' });
    await click('Sign In');                       // the submit button
    console.log('   operator signed in (password value is redacted in the log)');
  } else {
    console.log('   → open the console, click "Take control", sign in, then "Hand back".');
    await new Promise<void>((resolve) => {
      session.control.onChange((e) => { if (e.to === 'resume_requested') resolve(); });
    });
  }

  rule('4. HAND BACK — control does NOT snap straight to the agent');
  if (simulate) session.control.requestResume('scripted operator handing back');
  session.control.beginRelocalize();
  console.log(`   control : ${session.control.state}`);

  rule('5. RE-LOCALISE — the plan is a map, not a program counter');
  const obs = await surface.observe();
  const loc = localize(artifact, obs);
  console.log(`   ${loc.kind.toUpperCase()}: ${loc.detail}`);
  if (loc.kind === 'off_plan') {
    console.log(`   what the operator left us with:`);
    for (const n of obs.nodes.slice(0, 12)) {
      console.log(`     [${n.ref}] ${n.role} ${n.name ? `"${n.name}"` : ''}${n.anchorText ? ` anchor="${n.anchorText}"` : ''} frame=${n.frame}`);
    }
  }
  const decision = planReentry(artifact, loc, obs);
  if (!decision.safe) {
    session.control.handBackToOperator(decision.reason);
    console.log(`   REFUSED: ${decision.reason}`);
    process.exit(1);
  }
  console.log(`   resume at step ${decision.plan.resumeAt}`);
  if (decision.plan.willSkip.length) console.log(`   skipping (already performed): ${decision.plan.willSkip.join(', ')}`);
  session.control.returnToAgent(`re-localised: ${loc.detail}`);

  rule('6. RESUME — same session, no re-navigation, no lost state');
  const second = await replay({
    artifact, inputs: { memberId: '12345' }, surface,
    policy: defaultPolicy(new URL(baseUrl).origin), log, baseUrl,
    resumeFrom: decision.plan.resumeAt, skipNavigation: true,
  });
  console.log(`   status : ${second.status.toUpperCase()}`);
  if (second.status === 'success') console.log(`   outputs: ${JSON.stringify(second.outputs)}`);

  rule('SESSION LOG — one stream, both actors');
  for (const e of log.events) {
    const tag = { agent: '\x1b[36magent   \x1b[0m', operator: '\x1b[33moperator\x1b[0m', system: '\x1b[90msystem  \x1b[0m' }[e.actor];
    const d = e.detail ? JSON.stringify(e.detail).slice(0, 92) : '';
    console.log(`  ${tag} ${e.kind.padEnd(22)} ${d}`);
  }
  console.log(`\nevidence: ${log.dir}\n`);
  if (!simulate) { console.log('console still running — ctrl-c to exit'); await new Promise(() => {}); }
} finally {
  await consoleSrv.stop();
  await session.stop();
  await surface.close();
}
