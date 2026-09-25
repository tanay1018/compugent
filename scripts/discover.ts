/**
 * Run an LLM discovery pass against a live surface.
 *
 *   npm run discover -- "look up member 12345 and read their savings balance"
 *   npm run discover -- "<goal>" --url http://localhost:8710/?tenant=harbor
 */
import { readFileSync, existsSync } from 'node:fs';
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { loadPolicy } from '../src/policy/load.js';
import { RunLog } from '../src/run/log.js';
import { runDiscovery } from '../src/discovery/agent.js';

// Minimal env loading — no dependency, and it keeps keys out of argv.
for (const f of ['.env', '.env.local', '.env.txt']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]?.replace(/^["']|["']$/g, '') ?? '';
  }
}

const args = process.argv.slice(2);
const goal = args.find((a) => !a.startsWith('--')) ?? 'look up member 12345 and read their savings balance';
const urlFlag = args.indexOf('--url');
const port = process.env.TARGET_APP_PORT ?? '8710';
const entryUrl = urlFlag >= 0 ? args[urlFlag + 1]! : `http://localhost:${port}/?tenant=meridian`;

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('AI_GATEWAY_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const MODEL = process.env.DISCOVERY_MODEL ?? 'anthropic/claude-sonnet-5';
console.log(`\n  model   ${MODEL}   effort=${process.env.REASONING_EFFORT ?? 'low'}` +
            (/opus|fable|gpt-5\.|gemini-3/.test(MODEL) ? '   \x1b[33m(premium tier — npm run models for cheaper)\x1b[0m' : ''));
const loaded = loadPolicy(entryUrl);
console.log(`  policy  ${loaded.source}`);
const runId = `discovery-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const log = new RunLog('evidence', runId);
const surface = await PlaywrightSurface.launch({ headless: true });

try {
  const trace = await runDiscovery({
    goal,
    entryUrl,
    surface,
    policy: loaded.policy,
    log,
    maxSteps: 20,
  });
  log.writeJson('trace.json', trace);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`goal     : ${trace.goal}`);
  console.log(`outcome  : ${trace.outcome.toUpperCase()}`);
  console.log(`model    : ${trace.model}`);
  console.log(`tokens   : in=${trace.usage?.inputTokens ?? '?'} out=${trace.usage?.outputTokens ?? '?'}`);
  console.log(`evidence : ${log.dir}`);
  console.log(`${'='.repeat(64)}\n`);

  if (trace.outcome !== 'success' && trace.blockedReason) {
    console.log(`\n  \x1b[31mwhy:\x1b[0m ${trace.blockedReason}`);
    if (/budget|credit balance|quota/i.test(trace.blockedReason)) {
      console.log(`       your AI gateway key is out of budget — top up or raise the cap at`);
      console.log(`       https://vercel.com/[team]/~/ai`);
    }
    console.log('');
  }
  for (const s of trace.steps) {
    const t = s.target;
    const id = t.name ? `"${t.name}"` : t.anchor ? `${t.anchor.relation} "${t.anchor.text}"` : '?';
    console.log(`  ${String(s.index).padStart(2)}. ${s.kind.padEnd(7)} ${t.role.padEnd(8)} ${id}`);
    if (s.literal !== undefined) console.log(`      value   : ${JSON.stringify(s.literal)}   <- may become a parameter at compile time`);
    if (s.outputName) console.log(`      output  : ${s.outputName} = ${JSON.stringify(s.observedValue)}`);
    console.log(`      why     : ${s.rationale}`);
    console.log(`      effect  : ${s.effect}${s.targetVerified ? '' : '   [UNVERIFIED DESCRIPTOR]'}`);
  }
  if (trace.checkpoint) {
    const c = trace.checkpoint;
    console.log(`\n  checkpoint: ${c.kind === 'nodeExists' ? c.description ?? '' : ''}`);
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
  if (trace.warnings.length) {
    console.log(`\n  warnings:`);
    for (const w of trace.warnings) console.log(`    - ${w}`);
  }
  console.log('');
} finally {
  await surface.close();
}
