# Computer-Use Automation System

Record-once / replay-many automation for back-office applications that expose
no API. An LLM discovers how to accomplish a goal by driving the real UI; the
successful run is compiled into a typed, versioned **capability artifact**;
that artifact then replays deterministically with **no model in the decision
loop**, which is the path an AI agent invokes in production.

> Status: **Phase 5 — deterministic replay.** See `../ROADMAP.md` for the plan
> and `REPORT.md` (pending) for the design write-up.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env      # add your AI_GATEWAY_API_KEY
```

Only the *discovery* path needs a model. Replay never calls one, so the whole
replay demo runs with no key and no network.

## The target surface

A bundled legacy app, `MemberDesk 7.2` by fictional vendor Corelink:

```bash
npm run app     # http://localhost:8710/
```

Frameset shell, nested-table layout, no test ids, and no `<label for>` — so
the accessibility tree exposes its inputs with **no accessible name at all**.
That is deliberate: it is what forces anchor-relation targeting instead of
rewarding a clean selector.

Two tenants run the same vendor product, configured differently — the
multi-tenant reality in miniature:

| Tenant | Hostility | Field label | Submit |
|---|---|---|---|
| `?tenant=meridian` | L1 | "Member ID" | named button |
| `?tenant=harbor` | L2 | "Account Number" | unlabelled image input |

### Fault matrix

Faults are keyed on the input so every evidence run is reproducible:

| Input | Condition | Taxonomy tier |
|---|---|---|
| `12345` `67890` `55501` | happy path | success |
| `99999` | no member found | **business outcome** |
| `40001` | 8s stall | **recoverable** |
| `40002` | unexpected interstitial | **recoverable** |
| `40003` | permission denied | **business outcome** |
| `40004` | HTTP 500 | **hard failure** |
| `40005` | session expired (stateful) | **escalate** |

## Layout

```
src/schema/      persisted types — cross into saved artifacts
src/surface/     ephemeral types — the perceive/act seam, never persisted
src/policy/      allowlist, effect classification, redaction
target-app/      MemberDesk 7.2
evidence/        discovery + replay runs
```

The split between `src/schema` and `src/surface` is the central boundary: if a
platform detail can reach a stored artifact, that artifact stops being
portable across surfaces and tenants.

## Seeing what the system perceives

```bash
npm run app                                              # terminal 1
npm run observe -- http://localhost:8710/?tenant=harbor   # terminal 2
```

```
frame "main"
  [5] textbox   anchor="Account Number" (inSameRowAs)
  [7] combobox  anchor="Lookup By" (inSameRowAs) value="Member Number"
  [9] button    "Submit" anchor="Action" (inSameRowAs)
```

Two things that output makes concrete:

- The lookup field has **no accessible name**. Name-based targeting is dead on
  arrival here; the adjacent-cell anchor is the only durable identity.
- The submit button reports `"Submit"` — a name **the browser synthesised**,
  because the author gave the image input no alt text. Trusting it would pin
  the artifact to a Chrome default rather than to app content. Descriptors
  therefore record name *and* anchor, and resolution prefers the name but
  falls through to the anchor.

## Tests

```bash
npm test               # resolver — pure, fixture-driven, no browser (10 tests)
npm run test:integration   # real surface against the real legacy app (4 tests)
```

Target resolution is a pure function of `(Observation, TargetDescriptor)`, so
the most safety-critical logic in the system — anchor matching and ambiguity
detection — is tested without launching anything.

## Discovery (the LLM path)

```bash
npm run app                                                        # terminal 1
npm run discover -- "look up member 12345 and read their savings balance"
```

Needs `AI_GATEWAY_API_KEY`. A run costs roughly $0.12 against
`anthropic/claude-opus-5` and writes to `evidence/discovery-<timestamp>/`:
`trace.json`, an actor-tagged `run.jsonl`, and per-step screenshots.

The model never sees HTML — only the normalised graph that `npm run observe`
prints. Its action vocabulary is exactly what a recorded step can express, so
compiling a trace into an artifact is mechanical rather than an exercise in
parsing intent back out of a transcript.

Two gates run during discovery, both of which fail at *record* time rather
than in production:

- **Descriptor verification.** Every synthesised descriptor is immediately
  resolved back against the observation it came from. If it does not find
  exactly the node the model meant, the step is flagged.
- **Extraction targets are anchor-only.** For an output, the node's text is the
  payload, not its identity — recording `"$4,182.55"` as the locator would pin
  the artifact to one member. If a value has no anchor, the run refuses to
  record it and says so.

## Compilation (trace → capability)

```bash
npm run compile          # compiles the newest discovery run
```

Two passes. The **mechanical** one derives steps, targets, waypoints, outputs
and the checkpoint straight from the trace — possible only because the model's
action vocabulary was constrained to what a step can express. The
**generalisation** pass is a single LLM call that decides which run-constants
are really parameters:

```
1. select   combobox inSameRowAs "Search Type"   "Member Number"   <- fixed config
2. type     textbox  inSameRowAs "Member ID"     <memberId>        <- lifted to a param
3. click    button   "Search"
```

Getting that split wrong either pins the capability to one record or exposes a
knob no caller should think about. The proposal is **validated, not trusted**:
every proposed parameter must correspond to a literal that actually appears at
the step it claims, or it is dropped and recorded as a warning.

The model runs here exactly once, offline, on a run a human is about to
review. Replay never calls it.

Compiled artifacts land in `artifacts/<id>/v<n>.json` and project directly to
an agent-callable tool:

```json
{ "name": "member_readSavingsBalance",
  "description": "...\nReturns: { savingsBalance: number, memberId: string, memberName: string }",
  "input_schema": { "type": "object", "properties": { "memberId": { "type": "string" } },
                    "required": ["memberId"], "additionalProperties": false } }
```

Artifacts compile as `draft`. Unattended replay has to be opted into, because
a fresh artifact has been executed exactly once, by a model, on one tenant.

## Deterministic replay (the production path)

```bash
npm run replay -- member.readSavingsBalance memberId=12345
```

**No model is invoked.** That is asserted structurally, not just documented —
`test/replay-purity.test.ts` fails the build if anything reachable from the
replay engine imports an LLM SDK.

```
STATUS   SUCCESS   (969ms, no model invoked)
OUTPUTS  { "savingsBalance": 4182.55, "memberName": "Sarah Chen", "memberId": "12345" }
STEPS
  ✓ 1. type    textbox inSameRowAs "Member ID"    456ms  via:anchor
  ✓ 2. click   button  named "Search"             240ms  via:name
```

### The error taxonomy

Outcome signatures are **learned from runs that actually produce them**, never
guessed from a happy path:

```bash
npm run learn-outcomes          # publishes v2 with 5 verified outcomes
```

The wording is discovered by diffing observations; the *classification* is
authored, because no amount of diffing tells you that "not authorized" is a
legitimate answer while "error 0x5F" is a fault.

| input | what happens | result |
|---|---|---|
| `12345` | happy path | `success` — outputs returned |
| `99999` | no such member | `business_outcome` — **an answer, not a crash** |
| `40003` | operator lacks rights | `business_outcome` |
| `40001` | app stalls 8s | `success` — *waiting is the recovery* |
| `40002` | surprise interstitial | `success` — dismissed, checkpoint re-verified |
| `40004` | app returns 500 | `failed` — step, expected, observed |
| `40005` | session expires | `escalated` — a human must sign in |

Add `--unattended` to any of these and a draft artifact is refused outright: an
artifact executed exactly once, by a model, against one tenant has not earned
unattended production use.

## Demo path

The full thread, end to end:

```bash
npm install && npx playwright install chromium
cp .env.example .env                        # add AI_GATEWAY_API_KEY
npm run app                                 # terminal 1

npm run discover -- "look up member 12345 and read their current savings balance"
npm run compile                             # trace -> artifacts/<id>/v1.json
npm run learn-outcomes                      # -> v2, with verified outcomes
npm run replay -- member.readSavingsBalance memberId=12345    # success
npm run replay -- member.readSavingsBalance memberId=99999    # business outcome
npm run replay -- member.readSavingsBalance memberId=40004    # hard failure
```

Only the first two commands need a key. Everything from `replay` onward runs
offline against the saved artifact — see `evidence/README.md` for recorded runs
of every branch.
