/**
 * Generate the site's data from the repo's real evidence.
 *
 * Nothing here is authored by hand: every run, step and screenshot on the site
 * came out of an actual recorded run, so the case study cannot drift away from
 * what the system does. If a run is re-recorded, the site changes with it.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT  = join(import.meta.dirname, 'data');

/** Runs worth showing, in the order they tell the story. */
const FEATURED = [
  { id: 'discovery-2026-09-18T03-38-14-541Z', title: 'Wikipedia — a real site', kind: 'discovery',
    blurb: 'Search a company, open its article, read three facts out of the infobox. Every extraction resolves through the label beside it.' },
  { id: 'discovery-2026-09-18T03-11-18-420Z', title: 'weather.gov — a real form', kind: 'discovery',
    blurb: 'Type a ZIP, submit, read the result page. The capability this produced was later refused promotion.' },
  { id: 'discovery-2026-08-28T03-14-28-947Z', title: 'A deliberately hostile app', kind: 'discovery',
    blurb: 'Frameset, unlabelled inputs, async tables — built to force the anchor path that real legacy software produces by accident.' },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const runs = [];
for (const f of FEATURED) {
  const dir = join(ROOT, 'evidence', f.id);
  if (!existsSync(dir)) { console.warn(`skip ${f.id}: not present`); continue; }

  const events = readFileSync(join(dir, 'run.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // Screenshots are the expensive part of the payload, so only the ones an
  // event actually points at are copied.
  const shots = new Set(events.map((e) => e.screenshot).filter(Boolean));
  if (shots.size) {
    mkdirSync(join(OUT, f.id, 'screenshots'), { recursive: true });
    for (const s of shots) {
      const from = join(dir, s);
      if (existsSync(from)) cpSync(from, join(OUT, f.id, s));
    }
  }

  const trace = existsSync(join(dir, 'trace.json'))
    ? JSON.parse(readFileSync(join(dir, 'trace.json'), 'utf8')) : null;

  const tokens = events.filter((e) => e.kind === 'model.step')
    .reduce((a, e) => ({ in: a.in + (e.detail.in ?? 0), out: a.out + (e.detail.out ?? 0) }), { in: 0, out: 0 });

  runs.push({
    ...f,
    goal: trace?.goal ?? events[0]?.detail?.goal ?? '',
    outcome: trace?.outcome ?? 'unknown',
    entryUrl: trace?.entryUrl ?? '',
    tokens,
    ms: events.length > 1
      ? new Date(events.at(-1).ts).getTime() - new Date(events[0].ts).getTime() : 0,
    events: events.map((e) => ({
      seq: e.seq, actor: e.actor, kind: e.kind, ts: e.ts,
      screenshot: e.screenshot ? `${f.id}/${e.screenshot}` : null,
      detail: e.detail,
    })),
  });
}

/** The approved capability, shown as the typed object it is. */
const artifacts = [];
for (const id of ['wikipedia.readCompanyInfobox', 'member.readSavingsBalance']) {
  const dir = join(ROOT, 'artifacts', id);
  if (!existsSync(dir)) continue;
  const pick = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1);
  if (!pick) continue;
  artifacts.push(JSON.parse(readFileSync(join(dir, pick), 'utf8')));
}

writeFileSync(join(OUT, 'runs.json'), JSON.stringify(runs));
writeFileSync(join(OUT, 'artifacts.json'), JSON.stringify(artifacts));
console.log(`${runs.length} runs, ${artifacts.length} artifacts, ${runs.reduce((a, r) => a + r.events.length, 0)} events`);
