/**
 * Give the agent any goal and WATCH it work, with the option to take over.
 *
 *   npm run watch -- "look up member 67890 and read their checking balance"
 *   npm run watch -- "<goal>" --url "https://books.toscrape.com/"
 *   npm run watch -- "<goal>" --keep-open      # leave the console up afterwards
 *
 * Opens the operator console first, then runs discovery against the live
 * surface. You see every step as it happens and can click "Take control" at
 * any point — the agent yields at the next step boundary, you drive, and it
 * picks up from wherever you leave it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { defaultPolicy } from '../src/policy/allowlist.js';
import { RunLog } from '../src/run/log.js';
import { runDiscovery } from '../src/discovery/agent.js';
import { HandoffSession } from '../src/hitl/session.js';
import { OperatorConsole } from '../src/hitl/console.js';

for (const f of ['.env', '.env.local', '.env.txt']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]?.replace(/^["']|["']$/g, '') ?? '';
  }
}
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('AI_GATEWAY_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const args = process.argv.slice(2);
const goal = args.find((a) => !a.startsWith('--') && !/^https?:/.test(a));
if (!goal) {
  console.error('Usage: npm run watch -- "<goal>" [--url <entry url>] [--keep-open]');
  process.exit(1);
}
const urlFlag = args.indexOf('--url');
const port = process.env.TARGET_APP_PORT ?? '8710';
const entryUrl = urlFlag >= 0 ? args[urlFlag + 1]! : `http://localhost:${port}/?tenant=${process.env.TENANT ?? 'meridian'}`;
const keepOpen = args.includes('--keep-open');
const maxSteps = Number(process.env.MAX_STEPS ?? 25);

const runId = `watch-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const log = new RunLog('evidence', runId);
const surface = await PlaywrightSurface.launch();
const session = new HandoffSession(surface, log);
const consoleSrv = new OperatorConsole(session, log, Number(process.env.CONSOLE_PORT ?? 8790));

// Hand control back to the agent as soon as the operator releases it. During
// discovery there is no artifact to re-localise against — the model simply
// observes wherever it has been left. Plans are what create that problem.
session.control.onChange((e) => { if (e.to === 'resume_requested') session.resumeDiscovery(); });

// A run spawned by the desktop app must not outlive it -- an orphan keeps a
// browser and a console port alive forever, which is exactly how a stale
// console blocks the next launch.
//
// Watching stdin for EOF looks like the obvious way to detect a dead parent
// and is wrong: under `nohup` (or any `< /dev/null`) stdin reports EOF
// immediately and the run exits before it starts. Poll the parent pid
// explicitly instead, and only when the parent asked us to.
const parentPid = Number(process.env.RUNNER_PARENT_PID ?? 0);
if (parentPid > 0) {
  setInterval(() => {
    try { process.kill(parentPid, 0); } catch { process.exit(0); }
  }, 2000).unref();
}

try {
  await session.prepare();               // capture operator actions from the first document
  const url = await consoleSrv.start();

  const bar = '─'.repeat(68);
  console.log(`\n${bar}`);
  console.log(`  goal    ${goal}`);
  console.log(`  target  ${entryUrl}`);
  console.log(`  console \x1b[1m${url}\x1b[0m  ← open this to watch`);
const MODEL = process.env.DISCOVERY_MODEL ?? 'anthropic/claude-sonnet-5';
console.log(`  model   ${MODEL}   effort=${process.env.REASONING_EFFORT ?? 'low'}` +
            (/opus|fable|gpt-5\.|gemini-3/.test(MODEL) ? '   \x1b[33m(premium tier — npm run models for cheaper)\x1b[0m' : ''));

  if (consoleSrv.port !== Number(process.env.CONSOLE_PORT ?? 8790)) {
    console.log(`          (port ${process.env.CONSOLE_PORT ?? 8790} was busy)`);
  }
  console.log(`${bar}\n  Take control at any time; the agent yields at the next step boundary.\n`);

  const trace = await runDiscovery({
    goal, entryUrl, surface, policy: defaultPolicy(new URL(entryUrl).origin),
    log, maxSteps, session,
  });
  log.writeJson('trace.json', trace);

  console.log(`\n${bar}`);
  console.log(`  ${trace.outcome.toUpperCase()}   ${trace.steps.length} steps   ` +
              `in=${trace.usage?.inputTokens ?? '?'} out=${trace.usage?.outputTokens ?? '?'}`);
  console.log(bar);
  if (trace.outcome !== 'success' && trace.blockedReason) {
    console.log(`\n  \x1b[31mwhy:\x1b[0m ${trace.blockedReason}`);
    if (/budget|credit balance|quota/i.test(trace.blockedReason)) {
      console.log(`       your AI gateway key is out of budget — top up or raise the cap at`);
      console.log(`       https://vercel.com/[team]/~/ai`);
    }
    console.log('');
  }
  for (const s of trace.steps) {
    const id = s.target.name ? `"${s.target.name}"` : s.target.anchor ? `${s.target.anchor.relation} "${s.target.anchor.text}"` : '?';
    console.log(`  ${String(s.index).padStart(2)}. ${s.kind.padEnd(7)} ${s.target.role.padEnd(8)} ${id}`);
    if (s.literal !== undefined) console.log(`      value  ${JSON.stringify(s.literal)}`);
    if (s.outputName) console.log(`      output ${s.outputName} = ${JSON.stringify(s.observedValue)}`);
    if (!s.targetVerified) console.log(`      \x1b[33mUNVERIFIED: ${s.targetProblem}\x1b[0m`);
  }
  if (trace.stepUsage?.length) {
    console.log(`\n  TOKENS PER MODEL CALL`);
    console.log(`    ${'#'.padStart(3)}${'input'.padStart(9)}${'cached'.padStart(9)}${'reasoning'.padStart(11)}${'output'.padStart(8)}`);
    let ti = 0, tc = 0, tr = 0, to = 0;
    for (const [i, u] of trace.stepUsage.entries()) {
      ti += u.in; tc += u.cached; tr += u.reasoning; to += u.out;
      console.log(`    ${String(i + 1).padStart(3)}${String(u.in).padStart(9)}${String(u.cached).padStart(9)}${String(u.reasoning).padStart(11)}${String(u.out).padStart(8)}`);
    }
    console.log(`    ${'tot'.padStart(3)}${String(ti).padStart(9)}${String(tc).padStart(9)}${String(tr).padStart(11)}${String(to).padStart(8)}`);
    if (tc === 0) console.log(`    cached=0 across every call — the provider is not reusing the prompt prefix`);
    if (tr > to) console.log(`    reasoning exceeds output — lower REASONING_EFFORT or pick a non-reasoning model`);
  }
  const humanSteps = log.events.filter((e) => e.actor === 'operator' && e.kind.startsWith('manual.')).length;
  if (humanSteps) console.log(`\n  ${humanSteps} operator action(s) recorded in the same log.`);
  console.log(`\n  evidence: ${log.dir}`);

  if (trace.outcome === 'success') {
    console.log(`\n  Next:`);
    console.log(`    npm run compile -- ${log.dir}`);
    console.log(`    npm run replay -- <capability.id> <param>=<value>${urlFlag >= 0 ? ` --url "${entryUrl}"` : ''}`);
  }
  console.log('');

  if (keepOpen) {
    console.log('  console still up — ctrl-c to exit\n');
    await new Promise(() => {});
  }
} finally {
  await consoleSrv.stop();
  await session.stop();
  await surface.close();
}
