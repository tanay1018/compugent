# Computer-Use Automation System

Record-once / replay-many automation for back-office applications that expose
no API. An LLM discovers how to accomplish a goal by driving the real UI; the
successful run is compiled into a typed, versioned **capability artifact**;
that artifact then replays deterministically with **no model in the decision
loop**, which is the path an AI agent invokes in production.

> Status: **Phase 8 — verified on a live public site.** See `../ROADMAP.md` for
> the plan and `REPORT.md` (pending) for the design write-up.

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

## Give it any goal and watch it work

```bash
npm run app                                             # terminal 1
npm run watch -- "look up member 55501 and report their account status and checking balance"
npm run watch -- "<any goal>" --url "https://books.toscrape.com/" --keep-open
```

Opens the operator console at `http://localhost:8790/` **first**, then runs
discovery against the live surface, so you see every step as it happens.

The console is a **web** client, not a desktop app — deliberately. Production
replay runs headless in a container with the operator attaching remotely, so
an embedded browser would only ever work when the operator sits on the same
machine as the automation. Frames go out over CDP screencast; input comes back
gated on the control token.

### Barge-in

Click **Take control** at any point during a run. The agent finishes its
in-flight action, yields at the step boundary, and blocks:

```
agent     act.type              in-flight action completes first
operator  control.transition    agent -> pause_requested
agent     control.transition    pause_requested -> operator     the AGENT yields
system    discovery.paused
```

Handing back resumes the same run. Note there is no re-localisation here, and
that is not an oversight: during discovery there is no artifact to be lost
against, so the model simply observes wherever you left the session. *Plans are
what create the resumption problem.*

**Limitation, measured:** the action the model had requested when you
interrupted is deliberately **not** performed — the screen may have changed
under it — and it is told so explicitly. Even so, interrupting during an
in-flight navigation on a slow page can leave the model unable to re-orient; in
that case it gives up cleanly rather than thrashing. Interrupting between steps
on a settled page recovers reliably.

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

## Human-in-the-loop handoff

```bash
npm run handoff                # opens a real operator console and waits for you
npm run handoff -- --simulate  # scripted operator, for reproducible evidence
```

The scenario: a lookup dies because the session expired. Automation is not
permitted to handle credentials, so it cannot recover — it escalates. A human
signs in **on the same live session** and hands back. Replay then works out
where it is and finishes.

```
1. REPLAY        ESCALATED — session expired, automation cannot re-authenticate
2. ESCALATION    console at http://localhost:8790/ · control: pause_requested
3. TAKEOVER      control: operator — the human drives THE SAME session
4. HAND BACK     control: relocalizing — it does NOT snap back to the agent
5. RE-LOCALISE   LOCATED: steps 1,2 share this screen; resuming at 1 — safe to redo
6. RESUME        SUCCESS { savingsBalance: 4182.55, memberName: "Sarah Chen" }
```

### The control token

There is **no "both" state**. While automation holds control, operator input
does not leak through — it raises a pause request. While the operator holds it,
the executor is hard-blocked. Barge-in is atomic at *step* boundaries: waits are
interruptible, actions are not, so every logged event has an unambiguous actor.
Illegal transitions throw rather than silently corrupting who is driving.

### Re-localisation

> The plan is a map, not a program counter.

After a takeover the step index is meaningless — the human may have gone
forward, backward, somewhere unrelated, or finished the job. So replay observes
and asks *where am I*:

| waypoints matching | response |
|---|---|
| the checkpoint | the human finished it — extract outputs |
| exactly one | resume there, **even if that is backward** |
| several, all safe to redo | resume at the earliest |
| several, one irreversible | **stop** — we cannot tell if it already ran |
| none | **stop** — automation will not guess its position |

Re-entry is effect-aware. Before re-running an irreversible step, its
idempotency probe must answer "has this already happened?" — because an
operator who already submitted the form, then handed back, must not have a
second sub-account opened on their behalf.

### One log, both actors

```
agent     step.click       {"target":"button named \"Search\"","via":"name"}
system    outcome.matched  {"name":"session_expired","classification":"escalate"}
operator  manual.input     {"control":"Operator ID","value":"jchen"}
operator  manual.input     {"control":"Password"}          <- value never captured
system    control.transition {"from":"relocalizing","to":"agent"}
```

The operator's actions are captured *semantically*, not as pixels — an auditor
needs "typed into the Member ID field", not a video. Attribution is decided by
**who holds the token**, not by the event, since the agent's own input fires the
same DOM listeners.

## A second surface, one we did not write

The bundled app proves the technique; a site we do not control proves the
*driver* does not depend on it. Same code, no schema changes:

```bash
npm run discover -- "Open the book 'The Grand Design' from the Science category \
  and read its price including tax and how many copies are in stock" \
  --url "https://books.toscrape.com/"
npm run compile
npm run replay -- catalogue.readBookPriceAndStock \
  categoryName=Poetry "bookTitle=The Black Maria" --url "https://books.toscrape.com/"
```

`books.toscrape.com` is published expressly for automation practice, is
read-only, and has no side effects. Its product page puts data in a
label/value table — so the *same* `inSameRowAs` anchors that carry MemberDesk
carry it too:

```
extract cell inSameRowAs "Price (incl. tax)"   -> priceInclTax
extract cell inSameRowAs "Availability"        -> availability
```

### Recorded once, replayed with different inputs

The parameters here generalise the step's **target**, not a typed value —
"click the row for member 12345" is the pattern every back-office result grid
uses, so descriptors support `{{param}}` placeholders:

| inputs | result |
|---|---|
| `Science` / `The Grand Design` *(as recorded)* | `success` — £13.76, 5 available |
| `Poetry` / `The Black Maria` | `success` — £52.15, 19 available |
| `Travel` / `Neither Here nor There` | `success` — £38.95, 3 available |
| `Poetry` / `No Such Book` | `failed` — `waypoint_failed`, with the interpolated target in the message |

Three bugs only a real site could have surfaced, all fixed:

- **We never scrolled.** `DOM.getBoxModel` reports layout coordinates, so any
  element below the fold produced a click that landed on nothing — silently,
  because the event was still delivered. Every control in the bundled app fits
  on one screen, so it could never have caught this.
- **Ordinals counted the wrong population.** Every product tile carries two
  identically-named links (thumbnail and title). The record-time
  disambiguation indexed same-role siblings instead of the *matching
  candidates* that resolution actually applies an ordinal to, so descriptors
  shipped ambiguous.
- **Untruncated body copy.** One product description took a discovery run to
  124K input tokens. Node text is now capped at 200 chars: prose is never a
  target and never an output.

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
