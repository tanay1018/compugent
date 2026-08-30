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
| `40001` | 8s stall, correct record | **recoverable** — waiting is the recovery |
| `40002` | unexpected interstitial | **recoverable** — dismissed |
| `40003` | permission denied | **business outcome** |
| `40004` | HTTP 500 | **hard failure** |
| `40005` | session expired (stateful) | **escalate** |
| `40006` | valid screen, **wrong member** | **hard failure** — `output_mismatch` |

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

## The desktop app

```bash
npm run desktop
```

Type a URL and a goal, hit **Start run**, and the live browser session opens in
the window. The bundled MemberDesk target app starts automatically if the URL
points at localhost. Take control at any point; hand back and the agent picks
up from wherever you left it.

Three panes: the live session, the actor-tagged event log, and the runner's own
output (collapsible via **Log**). **New run** returns to the form.

The **Capabilities** tab is the other half — the catalog of what has been
recorded, with typed inputs, declared outputs, and the business outcomes each
one may return instead of success. **Run** replays a capability with whatever
parameters you type, **with no model in the loop**:

```
SUCCESS  959ms                      BUSINESS OUTCOME  919ms
{ "savingsBalance": 4182.55,        member_not_found
  "memberName": "Sarah Chen" }      No member matches that identifier.
                                    (an ANSWER, not a crash)
```

**Compile latest run → capability** turns the most recent successful discovery
run into a new artifact without leaving the app.

## Which sites does this actually work on?

Not all of them. Measured, by pointing the perception layer at a spread of real
sites and counting what it can see:

| Site | Nodes | Controls | Verdict |
|---|---|---|---|
| Wikipedia (server-rendered) | 1393 | 396 | works — 96% of controls named |
| Hacker News (table layout) | 743 | 230 | works — 86% named, anchors carry the rest |
| ParaBank (JSP, legacy) | 88 | 36 | works — the target shape |
| react.dev (modern SPA) | 552 | 50 | works — client-rendered is fine |
| example.com | 5 | 1 | works (trivially) |
| OpenCart demo | 12 | 2 | **blocked** — bot protection served an interstitial |
| Google Maps | 11 | 7 | **useless** — the map is a canvas with no a11y tree |

The rule of thumb: **if a screen reader can use it, so can this.** Anything
rendered to a `<canvas>` or WebGL exposes nothing to perceive, and the design's
answer there is the visual/OCR tier — designed, not built.

Four other real limits:

- **Login walls.** See below — automation is *refused* credential fields, and
  the flow escalates to a human instead.
- **Bot protection.** Cloudflare-style interstitials return a challenge page
  rather than the app. Nothing here tries to defeat them, and it should not.
  Amazon, for instance, serves a nine-node "Continue shopping" wall. The run
  warns before spending a model call on it:

  ```
  the entry page has no input controls and only 3 clickable element(s) across
  9 nodes — usually a bot wall, a consent gate, or a canvas-rendered app
  ```

  The signal is *no way to enter anything and almost nothing to click*, not a
  low node count — the bundled legacy app's entry screen is a perfectly
  workable 11 nodes.
- **Terms of service.** Automating a site can breach its terms. The bundled
  target app and `books.toscrape.com` are used precisely because they are
  published for this.
- **Infinite scroll / lazy lists.** Controls only exist once rendered; a
  descriptor for a row 300 items down will not resolve until it is scrolled
  into view, and nothing here drives that scrolling for you yet.

The shell is thin on purpose — it spawns the same `watch` run and embeds the
same operator console a remote operator would attach to. Production replay runs
headless in a container, so the console has to work over a channel; the desktop
window is packaging, not architecture.

## Or from the terminal — any goal, watched

```bash
npm run app                                             # terminal 1
npm run watch -- "look up member 55501 and report their account status and checking balance"
npm run watch -- "<any goal>" --url "https://books.toscrape.com/" --keep-open
```

Opens the operator console at `http://localhost:8790/` **first**, then runs
discovery against the live surface, so you see every step as it happens. This
is what the desktop app drives underneath.

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

Needs `AI_GATEWAY_API_KEY`. Writes to `evidence/discovery-<timestamp>/`:
`trace.json`, an actor-tagged `run.jsonl`, and per-step screenshots.

### Stopping conditions

A run ends on whichever comes first: the goal is met (`finish`), the model
calls `giveUp` because it cannot safely proceed, **max steps** (20, or 25 in
the desktop app), or a **wall-clock timeout** (4 minutes). Step count alone
does not bound a run — one step can sit on a slow page for a long time.

### Cost

```bash
npm run models              # cheapest tool-use models, live prices
npm run models -- openai    # filter
```

Set `DISCOVERY_MODEL` in `.env`. Nothing else changes — the gateway is why the
provider is a one-line decision. Estimates per run of ~20K in / 1.2K out:

| model | $/M in | $/M out | per run |
|---|---|---|---|
| `deepseek/deepseek-v4-flash` | 0.13 | 0.26 | **~$0.003** |
| `google/gemini-2.5-flash-lite` | 0.10 | 0.40 | ~$0.003 |
| `openai/gpt-5-mini` | 0.25 | 2.00 | ~$0.007 |
| `openai/gpt-4.1-mini` | 0.40 | 1.60 | ~$0.010 |
| `anthropic/claude-haiku-4.5` | 1.00 | 5.00 | ~$0.026 |
| `anthropic/claude-sonnet-5` *(default)* | 2.00 | 10.00 | ~$0.052 |
| `openai/gpt-5.6-sol` | 2.00 | 10.00 | ~$0.052 |
| `anthropic/claude-opus-5` | 5.00 | 25.00 | ~$0.130 |

Every run prints the model it is about to use, and flags the premium tier:

```
model   deepseek/deepseek-v4-flash   effort=low
```

**Untested.** These are list prices, not benchmarks — I have not run this
system on the non-Anthropic models, so treat the cheap end as a starting point
rather than a recommendation. The requirement is `tool-use`: the discovery loop
*is* tool calls, and a model without it cannot drive anything.

`COMPILE_MODEL` is separate and falls back to `DISCOVERY_MODEL`. Compilation is
a **single** call whose judgement — which literals are parameters, what the
contract looks like — is baked into every future invocation, so it is worth
keeping capable even when discovery runs on something cheap. One call at
premium rates is rounding error.

Model choice is the smaller lever. Three things drive the bill, in order:

**1. History growth.** The loop resends the whole conversation every step, and
each step appends a full screen rendering, so input grows *quadratically*.
Stale observations are now replaced with a one-line note of where the run was —
only the current screen is decidable-on:

```
what the model receives: 14550 -> 3770 chars (74% smaller)
```

That figure is measured at the model boundary with a mock model
(`test/loop-cost.test.ts`), not inferred — the reduction has to survive the SDK
actually honouring a `prepareStep` override, which is a separate question from
whether the compaction function works.

**2. Reasoning tokens.** Opus-class models think adaptively by default, and
every reasoning token is billed on output *and* resent as history on the next
step. Choosing which of a dozen labelled controls to click does not reward
extended thinking. `REASONING_EFFORT` (default `low`) turns it down.

**3. Screen size.** A content-heavy page can expose hundreds of nodes —
books.toscrape.com renders 402, Wikipedia 1393 — resent on every step.
`MAX_OBSERVATION_NODES` (default 140) caps it; controls are never dropped, long
runs of text are, and the model is told when it has been cut.

Every run now prints where its tokens went:

```
TOKENS PER MODEL CALL
  #    input   cached  reasoning  output
  1     1840        0        124     210
  ...
```

**On prompt caching:** the provider dashboard will show `cached = 0`, and that
is expected rather than a missed optimisation. Caching needs a byte-stable
prefix, compaction rewrites history every step, and what is left — a ~450-token
system prompt — sits under Anthropic's 1024-token minimum cacheable prefix.
Compaction and caching are in tension here, and for runs of more than two or
three steps compaction wins.

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

### Backtracking is compiled out

A discovery trace is a **walk**, not a route: the model tries a screen, finds a
dead end, goes back and takes a different turn. Recording that verbatim makes
replay re-enact the exploration — slower on every call, with more chances to
fail, for work whose result was thrown away.

So cycles are excised. When the walk leaves a screen and later returns to it,
everything from that screen's first visit is dropped:

```
lookup(1,2) -> detail(3,4) -> back to lookup(5,6)   compiles to   [5, 6]
```

Consecutive steps on one screen are *not* a cycle — typing into a field and
clicking the button beside it is ordinary sequential work. The assumption worth
stating: re-entering a screen gets it fresh. True for server-rendered apps,
which is the target here; it can fail on a SPA that preserves form state. So
anything dropped is listed in the artifact's warnings, and artifacts stay
`draft`.

### Saving

Artifacts are plain JSON, one file per version, directory named by id:

```
artifacts/member.readSavingsBalance/v1.json
artifacts/member.readSavingsBalance/v2.json     ← + learned outcomes
```

`save()` refuses to overwrite a version — re-recording lands as the *next* one —
and `load()` parses through the schema rather than casting, because a stored
artifact is untrusted input like any other. Not a database on purpose: a v1→v2
diff is exactly what a reviewer wants, and git already does that well.

**`load()` does not return the highest version. It returns the highest
*approved* one**, falling back to the highest overall when none is approved.
That rule earned its place: a re-record on a cheaper model produced a flow that
clicked Search before typing anything, compiled cleanly as v3, and would have
silently replaced a working capability for every caller.

```bash
npm run approve                                  # list every version and its state
npm run approve -- member.readSavingsBalance 2   # promote a reviewed one
```

```
member.readSavingsBalance   v1:draft  v2:approved  v3:draft
```

Approval is the only route to unattended replay, and the only thing that stops
a later draft shadowing a working capability.

### Saving a run that did not finish

```bash
npm run compile -- evidence/<run> --partial
```

By default a blocked run is refused. But discarding it throws away every step
that *did* work, and in a long back-office flow that is most of the run — so
`--partial` saves it at a third approval rung:

| approval | meaning | invocable |
|---|---|---|
| `incomplete` | no checkpoint — the run never established what success looks like | **no** |
| `draft` | complete, but run once, by a model, on one tenant | attended only |
| `approved` | reviewed | unattended |

`incomplete` is not a weaker `draft`; it is a different kind of thing. There is
genuinely nothing in it that could tell success from failure, so replay refuses
it outright rather than gating it:

```
CODE     not_approved
EXPECTED a completed capability with a checkpoint
OBSERVED member.lookupProfileAndBalances v1 is incomplete: discovery ended as
         "max_steps"; no checkpoint was established. Finish the recording first.
```

The schema enforces the pairing: a `draft` or `approved` artifact without a
checkpoint fails to parse, and an `incomplete` one must record *why*.

Compiled artifacts project directly to an agent-callable tool:

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

### Is it actually deterministic?

Determinism is a claim about repetition, so it is measured rather than asserted:

```bash
npm run replay -- member.readSavingsBalance memberId=12345 --repeat 6
```

```
  distinct statuses      1
  distinct outputs       1
  distinct resolution    1   (which tier each step matched through)
  timing                 871–968ms

  STABLE — identical result, outputs and resolution path every run
```

The third line is the one that matters. A step that sometimes matches by name
and sometimes by anchor is a descriptor drifting under you, and it will look
perfectly healthy on status and outputs right up until the day it doesn't.
Stable across the happy path, the business outcomes, the recovered
interstitial, the wrong-record failure — and on the live public site, where we
control nothing.

**What an operator-supplied credential does to this.** Nothing, because replay
refuses to contain the non-deterministic part. It does not pause and wait for a
human mid-flight; it **escalates and terminates**. The steps, targets and order
are fixed; a human supplying a value is an *input*, not a decision, and the run
that follows the handoff is a separate execution that **re-localises** first
rather than assuming it can continue at step *k+1*.

That is the whole reason resumption is a localisation problem: a pause is a
window in which the surface can change. Keeping the human strictly outside the
replay loop is what lets the loop stay deterministic.

### Login pages and credentials

Automation is **refused** a credential field. Not redacted afterwards —
refused. Redacting the log is a consolation prize: by then the value has been
typed into a live system by something that cannot be held accountable for it.

The check reads the control's **input type first, label second**. A label can
be omitted; ParaBank's login inputs carry no accessible name and no anchor text
at all, and an earlier label-only version of this check permitted them — the
password reached both the trace and the run log before that was caught.

```
BLOCKED: "Password" looks like a credential or regulated field. Automation
does not enter these — a human must. Escalate, or record the step as
operator-supplied.
```

The refusal happens before anything is done *or written down*, so a credential
never reaches the trace — and therefore can never reach an artifact, which is a
file that gets committed, diffed and shared. A stored literal that looks like a
credential also fails schema validation outright.

That leaves the question of how a flow behind a login is expressible at all.
A step's value can come from three places:

| `value.from` | meaning |
|---|---|
| `param` | supplied by the calling agent per invocation |
| `literal` | fixed configuration, baked in |
| `operator` | **supplied by a human at run time, never stored** |

The third is the answer. The artifact records that a credential is needed
*here* and what to ask for, while holding nothing. Replay escalates when it
reaches one:

```
STATUS   ESCALATED   (256ms, no model invoked)
REASON   step 1 needs a human: Enter the servicing operator ID
AT       step 1 · http://localhost:8710/login?tenant=meridian
```

and refuses outright if the caller asked for unattended execution:

```
CODE     not_approved
OBSERVED step 1 requires an operator-supplied value: Enter the servicing
         operator ID. This capability cannot run unattended.
```

Replay re-checks the field label too, rather than trusting the artifact — an
artifact is a file, and a file can be edited.

### How success is verified

Nothing here trusts the model's opinion that it succeeded. Five machine checks:

1. **Waypoint**, before each step — is the control I am about to use present?
2. **Resolution** — exactly one match, or `not_found` / `ambiguous`.
3. **Checkpoint**, before reading anything — a loop, so a recoverable
   interstitial is dismissed and the checkpoint re-tested.
4. **Every declared output must resolve**, else `output_missing`.
5. **Identity** — an output that echoes an input must still equal it.

The model's prose summary is stored for humans and is never what gets checked;
the checkpoint is an assertion:

```json
{ "kind": "nodeExists",
  "target": { "role": "text", "name": "Member Detail", "scope": { "frame": "main" } } }
```

Check 5 exists because the first four are not enough. A checkpoint proves you
reached the right **screen**, not that the screen is about the right
**record** — a cached page or a stale session renders a perfectly valid detail
screen for the wrong member, and every other assertion still holds:

```
input: memberId=40006
CODE     output_mismatch
EXPECTED "memberId" to echo the "memberId" input (40006)
OBSERVED the screen reports "12345" — this is a different record
```

The compiler derives that link mechanically: if an output came back reading
exactly what a parameter went in as, it is an echo of the input, and the
artifact asserts it rather than merely reporting it. In a bank this is the
difference between "read a balance" and "read the *right person's* balance".

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
