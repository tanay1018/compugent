/**
 * List gateway models that can actually run this system, with live prices.
 *
 *   npm run models              # cheapest 25 that support tool use
 *   npm run models -- anthropic # filter by substring
 *
 * Tool use is required. Cost assumes a run of ~20K input / 1.2K output tokens.
 */
const filter = process.argv[2]?.toLowerCase();
const res = await fetch('https://ai-gateway.vercel.sh/v1/models');
const { data } = (await res.json()) as { data: Array<Record<string, never>> };

type Row = { id: string; inp: number; out: number; ctx: number; est: number; reasoning: boolean };
const rows: Row[] = [];
for (const m of data as unknown as Array<{
  id: string; type?: string; tags?: string[]; context_window?: number;
  pricing?: { input?: string; output?: string };
}>) {
  if (m.type !== 'language') continue;
  if (!(m.tags ?? []).includes('tool-use')) continue;
  if (filter && !m.id.toLowerCase().includes(filter)) continue;
  const inp = Number(m.pricing?.input ?? 0) * 1e6;
  const out = Number(m.pricing?.output ?? 0) * 1e6;
  if (inp === 0 && out === 0) continue;
  rows.push({
    id: m.id, inp, out, ctx: m.context_window ?? 0,
    est: (inp * 20000) / 1e6 + (out * 1200) / 1e6,
    reasoning: (m.tags ?? []).includes('reasoning'),
  });
}
rows.sort((a, b) => a.est - b.est);

console.log(`\n${rows.length} tool-use models${filter ? ` matching "${filter}"` : ''}, cheapest first`);
console.log(`estimate assumes one discovery run of ~20K in / 1.2K out\n`);
console.log(`${'model'.padEnd(42)}${'$/M in'.padStart(8)}${'out'.padStart(8)}${'ctx'.padStart(8)}   est/run`);
console.log('─'.repeat(80));
for (const r of rows.slice(0, filter ? 40 : 25)) {
  console.log(
    `${r.id.padEnd(42)}${r.inp.toFixed(2).padStart(8)}${r.out.toFixed(2).padStart(8)}` +
    `${String(Math.round(r.ctx / 1000)).padStart(7)}k   $${r.est.toFixed(4)}${r.reasoning ? '  reasoning' : ''}`,
  );
}
console.log(`\nSet DISCOVERY_MODEL in .env to switch. Nothing else changes —`);
console.log(`the gateway is why the provider is a one-line decision.\n`);

export {};
