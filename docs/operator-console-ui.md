# Operator console UI

Visual spec for the desktop app (`electron/shell.html`) and the case-study site
(`site/styles.css`). Both read from the tokens defined here.

## 1. Purpose

The console is used to supervise automation of bank back-office software. An
automation and a human share one live session, and some actions cannot be
undone. The UI has to make three things obvious without any clicks:

1. **Who is driving** (agent or operator)?
2. **Is this discovery** (a model working it out) **or replay** (an artifact
   executing)?
3. **What has already happened that cannot be undone?**

Changes that make any of these harder to answer are wrong. Everything else is
secondary.

Style constraints: no gradients, no emoji as icons, no decorative accent bars,
no centred body copy, a maximum corner radius of 8px on anything holding data,
and one typeface family.

## 2. Color

Dark by default: the console sits beside a legacy app all day, and a bright
shell would compete with it.

### Ground

A cool near-black, biased toward the accent hue. Pure black makes the legacy
app's beige chrome look harsh.

| token | hex | role |
|---|---|---|
| `--bg` | `#0E1014` | app ground |
| `--surface` | `#161920` | panels, rails |
| `--surface-2` | `#1D2129` | raised: cards, inputs, hover |
| `--line` | `#252A34` | hairlines between regions |
| `--line-2` | `#333945` | borders on interactive elements |
| `--ink` | `#E4E8EE` | primary text |
| `--ink-2` | `#98A1B2` | secondary text |
| `--ink-3` | `#646D7E` | labels, disabled, metadata |

### Actor: who is driving

Used on **chrome only**: the control badge, the stage border, the rail marker
on an event.

| token | hex | role |
|---|---|---|
| `--agent` | `#6E9BF2` | automation holds control |
| `--human` | `#D99A4E` | a person holds control, or is needed |

`--human` covers both cases on purpose: an escalation is the operator's
business.

### Status: what happened

Used on **data only**: outcome pills, result panels, step marks. Keeping status
off the chrome stops it competing with the actor colors.

| token | hex | role |
|---|---|---|
| `--ok` | `#5FB88A` | success, or a business outcome the caller asked for |
| `--warn` | `#D99A4E` | recoverable, escalated, draft, fragile |
| `--bad` | `#DD6E5A` | hard failure, refused by policy, irreversible |
| `--info` | `#6E9BF2` | in progress, informational |

`--warn` shares its value with `--human`: both mean a person should look.

### Rules

- Hover and focus increase contrast; they never dim.
- The stage border is tinted with the current actor's hue, so the boundary
  between the console and the embedded app is always clear.
- `--bad` appears outside failures only to mark irreversible actions.

## 3. Type

One family, so there is no webfont to fail to load in an offline desktop app.

- **UI**: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
- **Data**: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace`, for
  anything a person may compare or copy: ids, targets, values, versions, token
  counts.

| step | size / line | weight | use |
|---|---|---|---|
| `display` | 24 / 1.2 | 600 | start-screen headline only |
| `title` | 19 / 1.3 | 600 | view title |
| `strong` | 15 / 1.45 | 550 | capability name, result heading |
| `body` | 13 / 1.55 | 400 | default |
| `dense` | 12 / 1.5 | 400 | event feed, table data |
| `label` | 11 / 1.4 | 600 | uppercase, `0.08em` tracking, `--ink-3` |

- Buttons and headings use Title Case; prose uses sentence case.
- `font-variant-numeric: tabular-nums` wherever digits are compared.
- Placeholders end with an ellipsis.
- No letter-spacing on lowercase body text.

## 4. Space and shape

4px base, 8px rhythm: `4 · 8 · 12 · 16 · 24 · 32 · 48`.

- `radius-sm` 4px: pills, chips, inputs, buttons
- `radius` 6px: cards, panels
- Hairlines are 1px `--line`; interactive borders are 1px `--line-2`.
- Shadows only on floating elements (drawer, popover), as a large soft cast.
- A label and its control share one hit target.

## 5. Components

**Control badge.** The most prominent element: a dot and the holder's name in
`label` type, tinted by actor. Always present, including mid-transfer, which
reads `HANDING OVER`.

**Stage.** The live session, with a 1px border tinted by the current actor.
While the operator holds control the border is `--human` and a hint sits below
it.

**Event feed.** One row per event: a mark, an actor rail, and a sentence rather
than JSON. Operator rows use a warm rail and a raised surface, so a handoff is
visible in the history. Marks: `✓` done · `◆` read · `●` finished ·
`!` needs a human · `✗` refused · `↻` recovered · `·` incidental.

**Capability card.** Shows what the capability is before offering to run it:
id, version and approval, description, typed contract (inputs → outputs, plus
possible outcomes), then the Run control. Approval pill colors: `approved`
`--ok`, `draft` `--warn`, `incomplete` `--bad`.

**Buttons.** Default is `--surface-2` with a `--line-2` border; one primary per
view. Loading keeps the label and adds a spinner. Buttons are disabled only
while a request is in flight. Irreversible actions use `--bad` on the border
and label, not a filled red block.

**States.** Every view handles empty, loading, populated and error. An empty
catalog explains how to add a capability and links to the action.

## 6. Motion

- `120ms ease-out` for state changes; `180ms` for the drawer.
- Transition named properties, never `all`.
- No entrance animations on data rows.
- Respect `prefers-reduced-motion`.
