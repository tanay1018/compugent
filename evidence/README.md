# Evidence

Recorded runs produced by the commands in [../README.md](../README.md). Each
directory holds an actor-tagged `run.jsonl` and screenshots, plus either a
`trace.json` (discovery) or a `result.json` (replay). No replay here called a
model.

## Saved artifacts

The capability artifacts live in [`../artifacts/`](../artifacts), one JSON file
per version. The ones exercised below:

| artifact | state | recorded by |
|---|---|---|
| [`member.readSavingsBalance/v4.json`](../artifacts/member.readSavingsBalance/v4.json) | approved | `watch-2026-08-29T21-40-47-229Z`; outcomes learned in v2 and v4 |
| [`member.openMoneyMarketSubAccount/v1.json`](../artifacts/member.openMoneyMarketSubAccount/v1.json) | draft | `discovery-2026-09-25T18-40-30-434Z` |
| [`wikipedia.readCompanyInfobox/v2.json`](../artifacts/wikipedia.readCompanyInfobox/v2.json) | approved | `discovery-2026-09-18T03-38-14-541Z` |
| [`weather.readForecastByZip/v2.json`](../artifacts/weather.readForecastByZip/v2.json) | draft (failed verify) | `discovery-2026-09-18T03-11-18-420Z` |

## Bundled target app: member lookup

### Discovery

- `watch-2026-08-29T21-40-47-229Z`: LLM run (from the desktop app) for "look up
  member 12345 and read their current savings balance". This is the run
  `member.readSavingsBalance` was compiled from.
- `discovery-2026-08-28T03-14-28-947Z`: an earlier LLM run of the same goal from
  the CLI.

### Replay across the error taxonomy

| memberId | scenario | status | outcome / code | time | run |
|---|---|---|---|---|---|
| `99999` | no such member | `business_outcome` | `member_not_found` | 891ms | `replay-2026-08-28T03-18-02-918Z` |
| `ABC12` | fails form validation | `business_outcome` | `invalid_member_id` | 1361ms | `replay-2026-09-25T18-43-41-839Z` |
| `40003` | operator lacks rights | `business_outcome` | `permission_denied` | 924ms | `replay-2026-08-28T03-18-31-531Z` |
| `40001` | 8 s stall | `success` | | 8754ms | `replay-2026-08-28T03-18-32-979Z` |
| `40007` | native `alert()` before the detail screen | `success` | `compliance_alert` recovered | 1426ms | `replay-2026-09-25T18-43-43-717Z` |
| `40004` | application returned HTTP 500 | `failed` | `app_error` | 898ms | `replay-2026-08-28T03-18-05-972Z` |
| `12345` | draft artifact with `--unattended` | `failed` | `not_approved` | 36ms | `replay-2026-08-28T03-18-30-700Z` |
| `40005` | session expired mid-run | `escalated` | `session_expired` | 942ms | `replay-2026-08-28T03-18-42-258Z` |

- Business outcomes are answers for the caller, not errors.
- `app_error` carries the step, what was expected, and what was observed.
- `escalated` stops at a state only a human can resolve, with a screenshot.
- `not_approved` is the draft gate: unattended callers cannot run an artifact
  that has not been approved.
- `40001` succeeds without any retry policy because the waypoint wait absorbs
  the stall.
- `40007`: replay matched the alert's text as a learned recoverable outcome,
  clicked **OK**, and re-tested the checkpoint. `screenshots/010-outcome-compliance_alert.png`
  is the dialog as the surface rendered it (the page itself cannot be captured
  while a native dialog blocks it).

### Verify and approval

`verify-2026-09-25T18-43-50-634Z`, `verify-2026-09-25T18-43-58-433Z`,
`verify-2026-09-25T18-43-59-817Z`: v4 (which added the validation and
native-dialog outcomes) replayed for the recorded member and two others, then
approved.

### Redacted inputs

`run.jsonl` records `memberId` as `[REDACTED]` because the compiler marked the
parameter sensitive. That is over-broad: it hides which member a run queried,
which is useful when debugging. A reviewer would clear the flag before
approving; it is an example of the kind of judgement the approval step exists
to check.

## Bundled target app: irreversible action and handoff

- `discovery-2026-09-25T18-40-30-434Z`: LLM run for "look up member 67890, open
  a new Money Market sub-account for them, and read the new account number".
  "Open Account" was classified irreversible; discovery is supervised, so the
  action was approved and logged.
- `replay-2026-09-25T18-44-24-542Z`: replay of the compiled capability stops
  **before** "Open Account" and returns `escalated`, with a screenshot of the
  form.
- `handoff-2026-09-25T18-42-05-098Z` (`npm run handoff -- --scenario irreversible --simulate`):
  the same escalation routed to the operator console; the operator takes
  control of the same session, submits the form, and hands back.
  Re-localisation finds the success checkpoint already holds, so replay reads
  the new account number without submitting again. One sub-account is opened.
- `handoff-2026-09-25T18-44-26-850Z` (`npm run handoff -- --simulate`): a
  session expiry escalates; the operator signs in on the same session (the
  password value is not captured) and hands back; replay re-localises to step 1
  and succeeds.

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
