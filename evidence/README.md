# Evidence

Recorded runs produced by the commands in [../README.md](../README.md). Each
directory holds an actor-tagged `run.jsonl`, screenshots, and either a
`trace.json` (discovery) or a `result.json` (replay). No replay here called a
model.

## Bundled target app

### Discovery

`discovery-2026-08-28T03-14-28-947Z`: LLM discovery run that produced
`member.readSavingsBalance`.

### Replay across the error taxonomy

| memberId | scenario | status | outcome / code | time | run |
|---|---|---|---|---|---|
| `99999` | no such member | `business_outcome` | `member_not_found` | 891ms | `replay-2026-08-28T03-18-02-918Z` |
| `40004` | application returned HTTP 500 | `failed` | `app_error` | 898ms | `replay-2026-08-28T03-18-05-972Z` |
| `12345` | draft artifact with `--unattended` | `failed` | `not_approved` | 36ms | `replay-2026-08-28T03-18-30-700Z` |
| `40003` | operator lacks rights | `business_outcome` | `permission_denied` | 924ms | `replay-2026-08-28T03-18-31-531Z` |
| `40001` | 8 s stall | `success` | | 8754ms | `replay-2026-08-28T03-18-32-979Z` |
| `40005` | session expired mid-run | `escalated` | `session_expired` | 942ms | `replay-2026-08-28T03-18-42-258Z` |

- `member_not_found` and `permission_denied` are business outcomes: the caller
  gets an answer, not an error.
- `app_error` carries the step, what was expected, and what was observed.
- `escalated` stops at a state only a human can resolve (re-authentication),
  with a screenshot of the screen at that point.
- `not_approved` is the draft gate: unattended callers cannot run an artifact
  that has not been approved.
- `40001` succeeds without any retry policy because the waypoint wait absorbs
  the stall.

### Redacted inputs

`run.jsonl` records `memberId` as `[REDACTED]` because the compiler marked the
parameter sensitive. That is over-broad: it hides which member a run queried,
which is useful when debugging. A reviewer would clear the flag before
approving; it is an example of the kind of judgement the approval step exists
to check.

## Public sites

### Discovery

- `discovery-2026-09-18T03-38-14-541Z`: **en.wikipedia.org**. Search for a
  company, open its article, read ISIN, industry and headquarters from the
  infobox. Infobox cells have no accessible name, so every extraction resolves
  through the neighbouring label (`inSameRowAs "ISIN"`).
- `discovery-2026-09-18T03-11-18-420Z`: **forecast.weather.gov**. Type a ZIP,
  submit, read values from the result page. See the verify runs below for why
  this capability was not approved.

### Repeated replay

`stability-1789855652758-0`, `stability-1789855664346-1`,
`stability-1789855675647-2`: `wikipedia.readCompanyInfobox` replayed three
times for `companyName=Microsoft`.

```
distinct statuses      1
distinct outputs       1
distinct resolution    1
timing                 11190–11410ms
STABLE
```

### Verify

- `verify-2026-09-19T22-06-34-362Z`, `verify-2026-09-19T22-06-45-649Z`:
  **GENERALISES.** Recorded on Bank of America, correct for Toyota
  (`JP3633400001`, Automotive, Toyota City). This is what promoted the
  capability to `approved`.
- `verify-2026-09-19T22-06-58-885Z`, `verify-2026-09-19T22-07-08-509Z`:
  **PINNED.** The weather capability anchored its temperature to
  `precededBy "Overcast"`, which is the current-conditions text rather than a
  label. It failed for Beverly Hills, and a day later failed on its own
  recorded ZIP when New York read "Fair". It stayed `draft`.

### Other replays

`replay-2026-09-19T22-14-16-168Z`, `replay-2026-09-19T22-14-19-257Z` and
`replay-2026-09-19T23-06-02-933Z` are single replays of the weather and
Wikipedia capabilities.
