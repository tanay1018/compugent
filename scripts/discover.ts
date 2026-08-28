/**
 * Run an LLM discovery pass against a live surface.
 *
 *   npm run discover -- "look up member 12345 and read their savings balance"
 *   npm run discover -- "<goal>" --url http://localhost:8710/?tenant=harbor
 */
import { readFileSync, existsSync } from 'node:fs';
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { defaultPolicy } from '../src/policy/allowlist.js';
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

const runId = `discovery-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const log = new RunLog('evidence', runId);
const surface = await PlaywrightSurface.launch({ headless: true });

try {
  const trace = await runDiscovery({
    goal,
    entryUrl,
    surface,
    policy: defaultPolicy(new URL(entryUrl).origin),
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

  for (const s of trace.steps) {
    const t = s.target;
    const id = t.name ? `"${t.name}"` : t.anchor ? `${t.anchor.relation} "${t.anchor.text}"` : '?';
    console.log(`  ${String(s.index).padStart(2)}. ${s.kind.padEnd(7)} ${t.role.padEnd(8)} ${id}`);
    if (s.literal !== undefined) console.log(`      value   : ${JSON.stringify(s.literal)}   <- Phase 4 lifts this to a typed parameter`);
    if (s.outputName) console.log(`      output  : ${s.outputName} = ${JSON.stringify(s.observedValue)}`);
    console.log(`      why     : ${s.rationale}`);
    console.log(`      effect  : ${s.effect}${s.targetVerified ? '' : '   [UNVERIFIED DESCRIPTOR]'}`);
  }
  if (trace.checkpoint) {
    const c = trace.checkpoint;
    console.log(`\n  checkpoint: ${c.kind === 'nodeExists' ? c.description ?? '' : ''}`);
  }
  if (trace.warnings.length) {
    console.log(`\n  warnings:`);
    for (const w of trace.warnings) console.log(`    - ${w}`);
  }
  console.log('');
} finally {
  await surface.close();
}
