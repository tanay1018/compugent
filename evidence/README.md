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
