# Case study site

Static. No framework, and no dependencies — `build.mjs` uses only Node builtins.

```bash
node build.mjs                 # regenerate data/ from ../evidence and ../artifacts
python3 -m http.server 8777    # then open http://localhost:8777
```

`build.mjs` is the whole pipeline: it reads the featured runs' `run.jsonl`,
copies only the screenshots an event actually references, and writes
`data/runs.json`. Nothing on the page is authored by hand, so the case study
cannot drift away from what the system does — re-record a run and the site
changes with it.

## Deploy

GitHub Pages, via `.github/workflows/pages.yml`. The workflow regenerates
`data/` on every push, so nothing generated is committed.

One-time setup: **Settings → Pages → Source: GitHub Actions**.

Every path in the page is relative, so it serves correctly from a project
subpath (`https://<user>.github.io/<repo>/`) without configuration.
