# Compugent

Record-once, replay-many automation for back-office web applications that have
no API.

1. **Discover.** An LLM drives the real UI through the accessibility tree until
   it reaches a goal.
2. **Compile.** The successful run is compiled into a typed, versioned
   **capability artifact**: inputs, steps, targets, outputs, and the business
   outcomes the flow can return.
3. **Replay.** The artifact runs deterministically with no model in the loop.
   This is the path a calling agent uses in production.

The design write-up is [REPORT.md](REPORT.md), with a longer version in
[docs/detailed-report.md](docs/detailed-report.md). Recorded runs are indexed in
[evidence/README.md](evidence/README.md).

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
cp .env.example .env      # set AI_GATEWAY_API_KEY
```

Only discovery and compilation call a model (via the Vercel AI Gateway). The
target app runs locally, and replay needs no key, so everything except
discovery and compilation works offline.

## Demo path

Start the bundled target app in one terminal:

```bash
npm run app
```

**1. Run the agent on a goal, then replay what it learned** (needs `AI_GATEWAY_API_KEY`):

```bash
npm run discover -- "look up member 12345 and read their current savings balance"
npm run compile                                                          # prints the capability id and version (a draft)
npm run replay -- member.readSavingsBalance memberId=67890 --latest      # replay the new draft with a different member
```

`compile` reuses the id of an existing capability for the same task, so the new
run is saved as the next version. `--latest` replays that version; without it,
replay uses the highest approved version.

**2. Replay without a key.** The repo ships approved artifacts with learned
outcomes, so the error handling can be exercised directly:

```bash
npm run replay -- member.readSavingsBalance memberId=12345     # success
npm run replay -- member.readSavingsBalance memberId=99999     # business outcome: member_not_found
npm run replay -- member.readSavingsBalance memberId=ABC12     # business outcome: invalid_member_id (validation)
npm run replay -- member.readSavingsBalance memberId=40007     # success after accepting a native alert
npm run replay -- member.readSavingsBalance memberId=40004     # failed: app_error
npm run replay -- member.readSavingsBalance memberId=40005     # escalated: session expired
```

```
STATUS   SUCCESS   (969ms, no model invoked)
OUTPUTS  { "savingsBalance": 4182.55, "memberName": "Sarah Chen", "memberId": "12345" }
STEPS
  ✓ 1. type    textbox inSameRowAs "Member ID"    456ms  via:anchor
  ✓ 2. click   button  named "Search"             240ms  via:name
```

**3. Escalate to a human and hand back** (scripted operator; drop `--simulate`
to do it yourself in the console at `http://127.0.0.1:8790`):

```bash
npm run handoff -- --simulate                            # session expired: a human signs in
npm run handoff -- --scenario irreversible --simulate    # "Open Account" needs a human to approve it
```

Restart `npm run app` between runs that use `40005`: it expires the target
app's session.

## Commands

| command | what it does |
|---|---|
| `npm run app` | Start the bundled target app (MemberDesk 7.2) on port 8710 |
| `npm run observe -- <url>` | Print the normalised accessibility graph the model sees |
| `npm run discover -- "<goal>" [--url <url>]` | LLM discovery run; writes `evidence/discovery-*` |
| `npm run watch -- "<goal>" [--url <url>] [--keep-open]` | Discovery with the operator console at `127.0.0.1:8790` |
| `npm run compile [-- <run> --partial]` | Compile a discovery run into an artifact |
| `npm run learn-outcomes` | Learn outcome signatures from the fault inputs |
| `npm run replay -- <id> k=v ... [--latest \| --version N] [--repeat N] [--unattended] [--url <origin>]` | Deterministic replay of the highest approved version, or the one given |
| `npm run verify -- <id> --case "k=v" ... [--approve]` | Replay against unseen inputs; optionally approve on success |
| `npm run approve [-- <id> <version>]` | List versions and their approval state, or approve one |
| `npm run handoff [-- --scenario session-expired\|irreversible] [--simulate]` | Escalation, human takeover of the live session, and resume |
| `npm run models [-- <filter>]` | List gateway models with tool use, cheapest first |
| `npm run desktop` | Electron app wrapping all of the above |

## How it works

### Perception and targeting

The model never sees HTML. Each screen is the accessibility tree of every
frame, filtered and normalised to a small role vocabulary. Legacy apps often
leave inputs with no accessible name, so every node is also given an **anchor**:
the nearest label, with its relation (`labelledBy`, `inSameRowAs`, `follows`,
`precededBy`).

```
$ npm run observe -- http://localhost:8710/?tenant=harbor
frame "main"
  [5] textbox   anchor="Account Number" (inSameRowAs)
  [7] combobox  anchor="Lookup By" (inSameRowAs) value="Member Number"
  [9] button    "Submit" anchor="Action" (inSameRowAs)
```

A target is stored as role + name + anchor, never a CSS selector or
coordinate. Resolution is a pure function of the observation and the
descriptor: it tries the name, then the anchor with its recorded relation, then
the anchor with any relation. More than one match is reported as `ambiguous`,
never resolved by taking the first.

### Discovery

The model's tools (`click`, `type`, `select`, `extract`, `finish`, `giveUp`)
match the step kinds an artifact can hold, so compilation is mechanical. A run
stops on `finish`, `giveUp`, the step limit (20; 25 in the desktop app) or a
4-minute timeout. Gates enforced during recording:

- one action per model step, so each action is chosen against the current screen
- every synthesised descriptor is resolved back against its observation
- extracted outputs must be anchored to a label, not to their own value
- credential fields are refused outright (see [Safety](#safety))
- an irreversible action cannot be repeated within a run

### Compilation

A single model call decides which literals from the run become parameters and
which are fixed configuration. Each proposed parameter is checked against the
trace and dropped with a warning if the literal does not appear at that step.
Everything else is derived mechanically: steps, targets, per-step waypoints,
outputs, the success checkpoint, and a canonical route pattern. Detours the
model took and backed out of are removed from the step list.

Artifacts are plain JSON, one file per version under `artifacts/<id>/`. A save
never overwrites an existing version, and loads are schema-validated. The
compiled artifact can be exposed directly as a tool definition for a calling
agent.

### Replay

Per step: wait for the step's waypoint, resolve the target, check policy, act,
settle. After the last step, verify the checkpoint, read outputs, and confirm
that any output echoing an input still matches it (so a valid screen for the
wrong record fails with `output_mismatch`). A test walks the replay engine's
import graph and fails if a model SDK is reachable.

Every result is one of four variants:

| status | carries |
|---|---|
| `success` | outputs |
| `business_outcome` | outcome name and message, e.g. `member_not_found` |
| `failed` | code, step, expected, observed, screenshot |
| `escalated` | reason, step, location, screenshot |

Outcome signatures are learned by running inputs that produce them and diffing
the screens. Whether an outcome is an answer, recoverable, a fault or an
escalation is declared in the artifact.

Native browser dialogs (`alert`, `confirm`) block the page, so while one is open
the observation is the dialog itself: its message plus **OK** / **Cancel**
buttons. Learning, outcome detection and recovery then handle it like any other
screen.

`--repeat N` reports distinct statuses, outputs, and which resolution tier each
step matched through. A step that switches tiers between runs is an early sign
of UI drift.

### Approval

| state | meaning | runnable |
|---|---|---|
| `incomplete` | saved with `--partial`; no checkpoint was reached | no |
| `draft` | compiled from one model run | attended only |
| `approved` | reviewed, or passed `verify --approve` | unattended |

`load()` returns the highest approved version, falling back to the highest
overall, so a newer draft cannot replace a working capability.
`--unattended` refuses anything below `approved`.

`npm run verify` replays a capability against inputs it was not recorded with.
It separates a capability that generalises from one that only works for the
recorded value:

```
$ npm run verify -- weather.readForecastByZip --case "zipCode=10001" --case "zipCode=90210"
  pass  recorded  {"currentTemperatureF":78,...}
  fail  unseen    output_missing: currentTemperatureF at text precededBy "Overcast"
  PINNED — works on the recorded value and fails on values it has not seen.
```

Here the compiler had anchored the temperature to the current-conditions text,
which is data rather than a label. The capability was never approved.

### Human in the loop

A single control token decides who drives the session: `agent`, `operator`, or
nobody during a transfer. Operator input raises a pause request while the agent
holds it; the executor is blocked while the operator holds it. Handover happens
at step boundaries.

```bash
npm run handoff -- --simulate                            # scripted operator
npm run handoff -- --scenario irreversible --simulate
npm run handoff                                          # do it yourself at http://127.0.0.1:8790
```

Two scenarios:

- **`session-expired`**: replay hits an expired session and escalates; a human
  signs in on the same browser session and hands back.
- **`irreversible`**: replay of `member.openMoneyMarketSubAccount` stops before
  **Open Account**, which policy says needs a human. The human reviews the form
  and submits it, then hands back.

Replay then **re-localises**: it observes the screen, finds which waypoints (or
the checkpoint) hold, and resumes from there, even if that is an earlier step.
In the second scenario the confirmation is already showing, so replay reads the
new account number without submitting again. If the position is ambiguous
around an irreversible step, or matches no waypoint, control stays with the
human.

Operator actions are logged semantically ("typed into Member ID") in the same
actor-tagged log as the agent's. Password values are never captured.

### Safety

- **Credentials are refused, not redacted.** A field is treated as a credential
  by input type first, then by label. The refusal happens before anything is
  typed or logged, so a credential cannot reach a trace or an artifact. Flows
  behind a login use an `operator` value source: the artifact records what to
  ask for, and replay escalates to a human at that step.
- **Irreversible steps** (classified at compile time from the control's label,
  reviewed with the artifact) stop replay and escalate unless an idempotency
  probe shows the effect has already happened. The compiler uses the success
  checkpoint as the default probe.
- **Allowlist.** [`policy.json`](policy.json) lists the permitted origins, path
  prefixes and action types. The entry URL is checked before navigating and the
  current page before every action, in discovery and replay.
- **Redaction.** SSNs, card numbers, account numbers and emails are redacted in
  run logs. Callers receive real values; the evidence directory does not.

## The target app

`npm run app` serves MemberDesk 7.2, a fictional legacy member-servicing app:
framesets, nested tables, no test ids and no `<label for>`. It has a member
lookup, and an **Open Sub-Account** form whose submit is irreversible (each
submit opens another account). Two tenants run the same product with different
configuration:

| tenant | field label | submit control |
|---|---|---|
| `?tenant=meridian` | "Member ID" | named button |
| `?tenant=harbor` | "Account Number" | image input with no alt text |

Faults are keyed on the input so every run is reproducible:

| memberId | condition | replay result |
|---|---|---|
| `12345` `67890` `55501` | normal | `success` |
| `99999` | no such member | `business_outcome` |
| `40001` | 8 s stall | `success` (the waypoint wait absorbs it) |
| `40002` | maintenance interstitial | `success` (dismissed, checkpoint re-checked) |
| `40003` | permission denied | `business_outcome` |
| `40004` | HTTP 500 | `failed` (`app_error`) |
| `40005` | session expired | `escalated` |
| `40006` | detail page for the wrong member | `failed` (`output_mismatch`) |
| `40007` | native `alert()` before the detail page | `success` (alert accepted, checkpoint re-checked) |
| anything not 5 digits, e.g. `ABC12` | form validation error | `business_outcome` (`invalid_member_id`) |

## Real sites

The same code runs against public sites with no changes. The Wikipedia
capability was recorded once on Bank of America and replayed for other
companies:

```bash
npm run replay -- wikipedia.readCompanyInfobox "companyName=Microsoft" --repeat 3
npm run verify -- wikipedia.readCompanyInfobox \
  --case "companyName=Bank of America" --case "companyName=Toyota" --approve
```

| company | ISIN | industry | headquarters |
|---|---|---|---|
| Bank of America *(recorded)* | US0605051046 | Financial services | Charlotte, NC |
| Microsoft | US5949181045 | Information technology | Redmond, WA |
| Toyota | JP3633400001 | Automotive | Toyota City, Japan |
| Airbus | NL0000235190 | Aerospace Defence | Leiden / Toulouse |
| Nintendo | JP3756600007 | Video games Electronics | Kyoto, Japan |

Infobox cells have no accessible name, so each value resolves through the
label in the neighbouring cell (`inSameRowAs "ISIN"`).

`catalogue.readBookPriceAndStock` (books.toscrape.com) shows parameters used
inside a target rather than as typed text, e.g. "click the link for
`{{bookTitle}}`".

In general this works on pages a screen reader can use. It does not work on
canvas or WebGL content, pages behind bot protection, or values with no nearby
label. See [docs/detailed-report.md §7.1](docs/detailed-report.md#71-known-limits-on-real-sites) for measured limits.

## Desktop app

```bash
npm run desktop
```

Enter a URL and a goal to start a watched discovery run. The live browser fills
the window, with a plain-language event feed beside it. The header always shows
who is driving (**AGENT** or **OPERATOR**); **Take control** hands the session
to you, and handing back resumes the run. A finished run can be saved as a
capability, and the **Capabilities** view replays any saved artifact with new
inputs.

Prebuilt macOS builds (Apple Silicon and Intel) are on the
[releases page](https://github.com/tanay1018/compugent/releases/latest). They
are not signed or notarized yet, so on first launch macOS blocks the app; allow
it under **System Settings → Privacy & Security → Open Anyway**. The API key is
entered in the app's Settings and stored locally.

The app is a thin shell over `npm run watch` and the same operator console a
remote operator would use. `npm run build:app` produces installers via
electron-builder. The UI spec is in [docs/operator-console-ui.md](docs/operator-console-ui.md).

## Configuration

Set in `.env` (see [.env.example](.env.example)):

| variable | default | purpose |
|---|---|---|
| `AI_GATEWAY_API_KEY` | | Required for discovery and compilation |
| `DISCOVERY_MODEL` | `anthropic/claude-sonnet-5` | Model for the discovery loop |
| `COMPILE_MODEL` | `DISCOVERY_MODEL` | Model for the single compile call |
| `REASONING_EFFORT` | `low` | Reasoning effort per discovery step |
| `MAX_OBSERVATION_NODES` | `140` | Cap on nodes rendered per screen |
| `TARGET_APP_PORT` | `8710` | Port for the bundled target app |
| `POLICY_FILE` | `./policy.json` | Allowlist file; without one, only the entry URL's origin is allowed |

The allowlist is [`policy.json`](policy.json). It is validated on load, and a
malformed file stops the run:

```json
{
  "allowedOrigins": ["http://localhost:8710", "https://en.wikipedia.org", "..."],
  "allowedPathPrefixes": ["/"],
  "allowedActions": ["click", "type", "select", "press", "navigate", "read"],
  "onIrreversible": "require_approval"
}
```

To run discovery against another site, add its origin first.

Discovery input is kept small by replacing earlier screens in the history with
a one-line summary (about 74% fewer input characters on a sample run) and
capping nodes per screen. Each run prints per-call token usage.

## Project layout

```
src/schema/     persisted types: artifact, target descriptor, state assertion
src/surface/    browser driver, perception, target resolution (never persisted)
src/discovery/  LLM discovery loop and observation rendering
src/compile/    trace -> artifact compiler
src/replay/     deterministic replay engine, outcome learning, result types
src/hitl/       control token, operator console, handoff session, re-localisation
src/policy/     allowlist and policy loading, effect classification, credential checks, redaction
src/store/      versioned artifact storage
scripts/        CLI entry points for the npm scripts above
target-app/     MemberDesk 7.2
electron/       desktop app
site/           static case-study site, generated from evidence/
artifacts/      compiled capabilities
evidence/       recorded discovery, replay, handoff and verify runs
docs/           detailed design report, operator console UI spec
policy.json     the allowlist
```

`src/schema` never imports from `src/surface`, so no browser-specific detail
can end up in a saved artifact.

## Tests

```bash
npm test                   # 64 unit tests, no browser
npm run test:integration   # real browser against the target app
npm run typecheck
```

Target resolution, compaction, backtrack pruning, the control token,
re-localisation, credential handling and replay purity are all tested without
launching a browser.
