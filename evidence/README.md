# Evidence

Runs produced by the commands in `../README.md`. Every replay below ran with
**no model in the decision loop** — the artifact carries everything needed.

## Discovery

`discovery-2026-08-28T03-14-28-947Z` — a real LLM run against the legacy target app: `trace.json`, an
actor-tagged `run.jsonl`, and per-step screenshots.

## Replay — the error taxonomy, exercised

| memberId | scenario | status | outcome / code | time | run |
|---|---|---|---|---|---|
| `99999` | no such member | **business_outcome** | `member_not_found` | 891ms | `replay-2026-08-28T03-18-02-918Z` |
| `40004` | application returned HTTP 500 | **failed** | `app_error` | 898ms | `replay-2026-08-28T03-18-05-972Z` |
| `12345` | draft artifact, --unattended | **failed** | `not_approved` | 36ms | `replay-2026-08-28T03-18-30-700Z` |
| `40003` | operator lacks rights | **business_outcome** | `permission_denied` | 924ms | `replay-2026-08-28T03-18-31-531Z` |
| `40001` | 8s stall — waiting IS the recovery | **success** | `success` | 8754ms | `replay-2026-08-28T03-18-32-979Z` |
| `40005` | session expired mid-run | **escalated** | `escalated` | 942ms | `replay-2026-08-28T03-18-42-258Z` |

Reading the table:

- `member_not_found` and `permission_denied` are **business outcomes**, not
  failures. The caller gets an answer; nothing crashed.
- `app_error` is a **hard failure**, carrying the step, what was expected, and
  what was observed.
- `escalated` is a session expiry — automation cannot re-authenticate, so a
  human is needed. Evidence includes the screen at the moment it stopped.
- `not_approved` is the draft gate: an unattended caller may not run an
  artifact that has been executed exactly once, by a model, on one tenant.

Two recoverable cases resolve to plain **success**, which is the point:

- `40001` (in the table above) stalls the app for 8s. No retry policy fires —
  *waiting is the recovery* — so it simply succeeds in ~8.8s.
- `40002` raises an unexpected maintenance interstitial. Replay recognises it,
  clicks the dismiss control the learner discovered, re-verifies the checkpoint,
  and completes in ~1.1s.

## A note on the redacted inputs

`run.jsonl` records `memberId` as `[REDACTED]`. That is redaction working —
nothing sensitive reaches disk — but it is also **over-broad**, and a real
example of why artifacts compile as `draft`. The compiler's generalisation pass
judged a member number sensitive; defensible, but it means evidence cannot show
which member a run queried, which is exactly what you want when debugging a
production failure. A reviewer would relax that flag before approving the
artifact. The mechanism is right; this particular call is the sort of thing the
approval gate exists to catch.

---

# Real sites

The runs above use the local target app, which is deliberately hostile
(frameset, unlabelled inputs, async tables). These use sites with real traffic,
where the hostility is not deliberate — it is just how the web is.

## Discovery

`discovery-2026-09-18T03-38-14-541Z` — **en.wikipedia.org**. Search for a
company, open its article, read ISIN / industry / headquarters out of the
infobox. Every extraction resolves through an anchor relation
(`inSameRowAs "ISIN"`) because an infobox cell has no accessible name of its
own: the label in the neighbouring cell *is* its identity. This is the anchor
path the local app was built to force, occurring naturally.

`discovery-2026-09-18T03-11-18-420Z` — **forecast.weather.gov**. A real form
submission: type a ZIP, submit, read values off the result page. Kept because
of how it ends, below.

## Deterministic replay on a live site

`stability-1789855652758-0`, `stability-1789855664346-1`, `stability-1789855675647-2` — the same capability replayed three times for
`companyName=Microsoft`:

    distinct statuses      1
    distinct outputs       1
    distinct resolution    1
    timing                 11190–11410ms
    STABLE

Same outputs, and the same *resolution tier* each time — a step that sometimes
matches by name and sometimes by anchor is a step about to break.

## The generalisation gate

A capability that works only for the value it was recorded on is a recording,
not a capability, and one green run cannot tell the difference: the recorded
case passes by construction. `npm run verify` replays against values the
artifact has never seen.

`verify-2026-09-19T22-06-34-362Z`, `verify-2026-09-19T22-06-45-649Z` — **GENERALISES**. Recorded once on Bank of America;
returns correct facts for Toyota (`JP3633400001`, Automotive, Toyota City).
Verified across Microsoft, Airbus and Nintendo too. This evidence is what
promoted it to `approved`.

`verify-2026-09-19T22-06-58-885Z`, `verify-2026-09-19T22-07-08-509Z` — **the gate earning its place.** The weather capability
anchored its temperature to `precededBy "Overcast"` — the *current conditions
text*, which is data, not a label. `verify` reported PINNED the day it was
recorded, because Beverly Hills was not overcast. Twenty-four hours later New
York was "Fair" and it failed on its own recorded ZIP as well.

It was never approved. The three-rung ladder held: the model produced it, the
compiler accepted it, and the gate refused to promote it. A single green replay
on the day of recording would have shipped it.

The lesson generalises past this one page: **an anchor must be a label, not a
value.** `inSameRowAs "ISIN"` survives because every company article has an ISIN
row; `precededBy "Overcast"` survives only until the weather changes.
