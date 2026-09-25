# Design Report

A model discovers how to do a task in a legacy UI once; the run is compiled into a typed, versioned **capability artifact**; replay executes the artifact with no model in the loop. The longer version of each section, with examples and measurements, is in [docs/detailed-report.md](docs/detailed-report.md).

## 1. Architecture

```
goal + URL ─▶ Discovery (LLM loop) ─▶ trace ─▶ Compiler (1 LLM call) ─▶ artifact vN (draft)
                     │                                                        │
                     ▼                                                        ▼
              Surface (accessibility tree + CDP input) ◀──────────── Replay (no LLM) ─▶ result
                     ▲                         Policy gates both ─┘
              Handoff session (control token, operator console)
```

| decision | choice | why |
|---|---|---|
| runtime | TypeScript, Node 20, Zod | one schema gives validation, types and the tool's JSON Schema |
| surface | Playwright's Chromium, driven over raw CDP | accessibility tree, input events and screencast are all CDP calls |
| perception | accessibility tree of every frame, not DOM or pixels | exists on legacy web, modern web and desktop; ~10× smaller than HTML |
| model | Vercel AI Gateway, model id in `.env` | the model is only used in discovery and compile, so it stays swappable |
| topology | one process | none of the hard problems change shape with more processes |
| target | bundled MemberDesk 7.2 (framesets, nested tables, no test ids) | only a local app can inject runtime faults reproducibly; also run on Wikipedia, books.toscrape.com and weather.gov |

**The one structural rule:** `src/schema` (persisted) never imports `src/surface` (ephemeral), so no selector, coordinate or platform handle can reach a saved artifact.

**Targeting.** Legacy screens leave inputs unnamed ("Member ID" is just the neighbouring `<td>`), so every node also gets an *anchor*: the nearest label and its relation (`labelledBy`, `inSameRowAs`, `follows`, `precededBy`). Name and anchor are recorded together because browsers synthesise names.

**Discovery** tools map one-to-one onto artifact step kinds (`click`, `type`, `select`, `extract`, `finish`, `giveUp`), so compilation is mechanical. One action per model step; stops on `finish`, `giveUp`, 20 steps or 4 minutes. **Compilation** is one LLM call to choose parameters, validated against the trace; everything else is derived, and detours are pruned.

## 2. Artifact schema

An artifact is a contract for what can be invoked, plus the script that fulfils it.

```
CapabilityArtifact
  id, version, name, description
  app        { vendorProduct, recordedTenant, surfaceKind, entryPathPattern }
  inputs[]   { name, type, required, description, example, sensitive }
  outputs[]  { name, type, from: TargetDescriptor, transform, sensitive, mustMatchParam? }
  outcomes[] { name, classification, detect: StateAssertion, message, recovery?, verified }
  steps[]    { id, kind, target, value?, waypoint, effect, idempotencyProbe?, fragile? }
  checkpoint StateAssertion
  approval   incomplete | draft | approved
  provenance { recordedAt, discoveryRunId, model, goal, warnings[] }
```

- **Contract** (`inputs`, `outputs`, `outcomes`) is read by the calling agent (`toToolSchema()` makes it a tool definition); **script** (`steps`, `checkpoint`) by replay; **safety** (`effect`, `idempotencyProbe`) by policy and re-entry; **waypoints** by re-localisation after a takeover.
- **TargetDescriptor** is role + name + anchor + frame name + optional ordinal. A bare role is rejected, CSS/XPath are never the primary locator, and `{{param}}` placeholders allow "the row for member {{memberId}}".
- **Value sources:** `param` (supplied per call), `literal` (fixed configuration), `operator` (typed by a human at run time and never stored), which is how a flow behind a login is expressible.
- **Outcomes live in the artifact**, not the engine: "not authorized" is an answer for a lookup and a fault for a batch job, so each capability declares its own.
- **`mustMatchParam`** ties an echoed identifier to its input: the checkpoint proves the right screen, this proves the right record.
- **Approval:** `incomplete` (no checkpoint, not runnable), `draft` (one model run, attended only), `approved` (reviewed or passed `verify`, unattended allowed). `load()` returns the highest *approved* version, so a newer draft cannot silently replace a working capability.
- One JSON file per version; saves never overwrite, loads are schema-validated.

## 3. Determinism & error handling

**Per step:** wait (up to 15 s) until the step's waypoint holds *or* the screen matches a declared outcome; resolve the target (exactly one match, else `target_not_found` / `target_ambiguous`, never "first match"); check policy; act; settle. After the last step, the checkpoint is verified in a loop so a recoverable outcome can be handled and the checkpoint re-tested; then outputs are read and `mustMatchParam` checked. A test fails if anything reachable from the replay engine imports a model SDK.

**Resolution tiers:** name → anchor with recorded relation → anchor with any relation → text fallback; the matched tier is logged per step. **Waiting** is document-ready plus quiet navigation and network; waiting on the waypoint doubles as the recovery for slow loads.

**Result contract,** a discriminated union so a caller cannot ignore business outcomes:

| status | carries |
|---|---|
| `success` | outputs |
| `business_outcome` | outcome name, message |
| `failed` | code, step, expected, observed, screenshot |
| `escalated` | reason, step, location, screenshot |

**Outcomes:** `learn-outcomes` diffs each fault input's screen against the happy path to learn the wording; the classification is declared by a human.

| input | condition | result |
|---|---|---|
| `99999` / `40003` | no such member / permission denied | `business_outcome` |
| `ABC12` | form validation error | `business_outcome` |
| `40001` | 8 s stall | `success` (the wait absorbs it) |
| `40002` | maintenance interstitial | `success` (dismissed, checkpoint re-tested) |
| `40007` | native `alert()` | `success` (accepted, checkpoint re-tested) |
| `40004` | HTTP 500 | `failed` · `app_error` |
| `40006` | valid screen, wrong member | `failed` · `output_mismatch` |
| `40005` | session expired | `escalated` |

An open native `alert`/`confirm` is reported as a dialog node with OK/Cancel buttons, so the same outcome machinery handles it.

**Measuring it:** `replay --repeat N` compares statuses, outputs and tiers. `verify` replays against inputs the artifact was *not* recorded with: the Wikipedia capability generalised to four other companies, while a weather.gov one that anchored to "Overcast" (data, not a label) was reported PINNED and never approved.

## 4. Heterogeneity & multi-tenant

**Surface seam.** Everything above `Surface` (`observe`, `resolve`, `act`, `screenshot`, `navigate`, `startStream`, `dispatchRawInput`) is surface-agnostic, and every role maps onto ARIA, macOS AX and Windows UIA. Legacy web is implemented (framesets by frame name, tables via `inSameRowAs`). `DesktopSurface` is a stub at the real signatures: a driver would walk AX/UIA into the same nodes, compute `inSameRowAs` geometrically, and run out of process over JSON-RPC. A visual/OCR fallback kind is reserved for Citrix and canvas.

**Multi-tenant reuse.** Artifacts store the vendor product and a canonical route pattern (`/detail?q1=12345` → `^/detail(\?|$)`); the origin is supplied per call. Markup differences replay unchanged (name and anchor, relaxed relation); wording differences do not: `harbor` labels "Member ID" as "Account Number", so the `meridian` artifact does not resolve there. The design is a per-tenant overlay keyed by `(vendorProduct, tenant)` that replaces names or anchor texts per step at load, so each institution owns a small reviewable delta.

**Drift signals:** a step changing resolution tier, `--repeat` reporting FLAKY, a waypoint holding only via a fallback. Known gap: a recording can rely on a dropdown default another tenant configures differently.

## 5. Escalation & handoff

**Stuck** means: discovery's `giveUp`, step limit or timeout; a refused credential field; a replay outcome classified `escalate`; an `operator` value; an irreversible step. A broken app is `failed`, not escalated. The escalation carries capability, step, reason, location and screenshot.

**Control token:** `agent → pause_requested → operator → resume_requested → relocalizing → agent` (or back to `operator`). No state lets both act: operator input during agent control only raises a pause request, and the executor is blocked while the operator drives. Handover happens at step boundaries, so every event has one actor.

**Same live session:** the browser stays in the runner; the console streams it over server-sent events and forwards raw input over POST, the shape of attaching to a containerised session. Operator actions are logged as labelled events (no password values) in the agent's log.

**Handing back = re-localisation.** The step index is meaningless after a takeover, so replay observes: checkpoint holds → read outputs; one waypoint → resume there, even backwards; several, all safe → earliest; ambiguous around an irreversible step, or no match → the human keeps control. Evidence has two scripted handoffs: signing in after a session expiry, and approving an irreversible "Open Account", after which replay finishes without submitting again.

## 6. Safety

- **Allowlist** from `policy.json`: exact origins, path prefixes and permitted action types, validated on load. The entry URL is checked before navigating and the current page before every action, so a click that leaves the allowlist cannot be followed by another action.
- **Irreversible actions** are classified at compile time from the label, reviewed with the artifact, and enforced by replay without re-guessing. `require_approval` stops before the step and escalates; `block` would make submitting impossible and `flag` is read after the money has moved. Discovery refuses to repeat one within a run, and each needs an idempotency probe (default: the success checkpoint) so re-entry does not repeat it.
- **Credentials are refused, not redacted.** A field is treated as a credential by input type first, then label; automation never types into it, so it never reaches a trace or artifact, and the schema rejects credential-like literals.
- **Redaction** happens when a value is logged: sensitive inputs and outputs, SSNs, card and account numbers, emails. Callers get real values; evidence does not.

**Limits:** the allowlist is per origin and path, not per control, and only the top-level page is checked; effect classification is label-based; redaction is pattern-based and over-broad in places; screenshots are not redacted; the console binds to `127.0.0.1` but has no authentication.

## 7. Cuts

| cut | what exists | to build it |
|---|---|---|
| desktop driver | `DesktopSurface` stub at the real signatures | out-of-process AX/UIA driver over JSON-RPC, plus the OS accessibility permission |
| visual / OCR tier | `visual` fallback kind in the schema | screenshot + OCR resolver for canvas and Citrix surfaces |
| tenant overlays | two tenants; `recordedTenant` on artifacts | per-tenant name/anchor overrides merged at load |
| specific idempotency probes | checkpoint used as the default probe | probes such as "the new record is in the list", so re-entry can skip a step the operator did and then navigated away from |
| default-state assertions | waypoints can express them | compiler asserts values the run relied on but never set |
| assisted recovery | escalation and the draft/approved gate | a bounded single-step model call on replay failure, saved as a new draft |
| catalog endpoint | `toToolSchema()`; the desktop app lists and runs capabilities | an HTTP or MCP endpoint for external agents |
| screenshot redaction | text logs are redacted | black out sensitive nodes' boxes before writing each screenshot |
| console auth | loopback-only binding | per-session token on every request |

Real-site limits (bot walls, unlabelled values, definition lists) are measured in [docs/detailed-report.md §7.1](docs/detailed-report.md#71-known-limits-on-real-sites).

**Next, in order:** prompt caching; a `describedBy` anchor relation; tenant overlays with default-state assertions; narrower idempotency probes; bounded single-step recovery on replay failure.
