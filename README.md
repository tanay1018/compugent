# Computer-Use Automation System

Record-once / replay-many automation for back-office applications that expose
no API. An LLM discovers how to accomplish a goal by driving the real UI; the
successful run is compiled into a typed, versioned **capability artifact**;
that artifact then replays deterministically with **no model in the decision
loop**, which is the path an AI agent invokes in production.

> Status: **Phase 2 — perception & acting.** See `../ROADMAP.md` for the plan
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

## Demo path

_Pending — Phase 3 onward._
