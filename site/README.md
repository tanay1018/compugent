# Case study site

Static site with no framework or dependencies; `build.mjs` uses only Node builtins.

```bash
node build.mjs                 # regenerate data/ from ../evidence and ../artifacts
python3 -m http.server 8777    # then open http://localhost:8777
```

`build.mjs` reads the featured runs' `run.jsonl`, copies only the screenshots
those events reference, and writes `data/runs.json`. The run player and the
capability demo are generated from this data rather than written by hand, so
re-recording a run updates the site.

## Deploy

GitHub Pages, via `.github/workflows/pages.yml`. The workflow regenerates
`data/` on every push, so nothing generated is committed.

One-time setup: **Settings → Pages → Source: GitHub Actions**.

Every path in the page is relative, so it serves correctly from a project
subpath (`https://<user>.github.io/<repo>/`) without configuration.
