# Case study site

Static. No framework, no build step beyond copying data out of the repo.

```bash
node build.mjs     # regenerate data/ from ../evidence and ../artifacts
python3 -m http.server 8777
```

`build.mjs` is the whole pipeline: it reads the featured runs' `run.jsonl`,
copies only the screenshots an event actually references, and writes
`data/runs.json`. Nothing on the page is authored by hand, so the case study
cannot drift away from what the system does — re-record a run and the site
changes with it.

## Deploy

Vercel, pointed at this directory:

```bash
npx vercel --cwd site
```

`vercel.json` sets `buildCommand` to `node build.mjs`, so a deploy regenerates
the data from whatever evidence is committed.
