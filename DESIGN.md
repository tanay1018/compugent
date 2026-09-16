# Design system — Operator Console

The design spec for the desktop app. Written before the CSS, so the interface
is a system rather than a pile of decisions.

---

## 1. What this is

An operator console for driving **regulated bank back-office software**. Two
actors — an automation and a human — share one live session, and one of them
can do things that cannot be undone.

That tension is the product. It decides the whole design:

> **Who is driving, and what can't be taken back.**
> Those two facts must be readable from across a room. Everything else is
> secondary.

Not a dashboard (nothing here is a metric). Not a chat UI (the model is not
the subject). It is a **control room**: a live view, a record of what happened,
and an unambiguous handle on control.

### Anti-patterns — what this deliberately is not

The templated default for "AI tool, dark theme" is a violet-to-blue gradient
hero, rounded-2xl cards with an accent bar, emoji section markers, and
everything centered. None of that appears here. Specifically banned:

- gradients of any kind, and violet/indigo as an accent
- emoji as iconography
- decorative accent bars on cards
- centered body copy
- `border-radius` above 8px on anything that holds data
- more than one typeface family

---

## 2. Color

Dark by default, because this runs beside a legacy banking app all day and a
bright shell would be the brightest thing on the screen.

### Ground

A cool near-black. Not pure black — pure black makes the legacy app's own beige
chrome scream — and the neutral is biased toward the accent hue so it reads as
chosen.

| token | hex | role |
|---|---|---|
| `--bg` | `#0E1014` | app ground |
| `--surface` | `#161920` | panels, rails |
| `--surface-2` | `#1D2129` | raised: cards, inputs, hover |
| `--line` | `#252A34` | hairlines between regions |
| `--line-2` | `#333945` | borders on interactive things |
| `--ink` | `#E4E8EE` | primary text |
| `--ink-2` | `#98A1B2` | secondary text |
| `--ink-3` | `#646D7E` | labels, disabled, metadata |

### Actor — who is driving

Two hues, used on **chrome only**: the control badge, the stage border, the
rail marker on an event. Seeing them anywhere else is a bug.

| token | hex | role |
|---|---|---|
| `--agent` | `#6E9BF2` | automation holds control |
| `--human` | `#D99A4E` | a person holds control, **or is needed** |

`--human` doing double duty is deliberate, not a collision. An escalation *is*
the operator's business; the interface should not need two colors to say
"a human is involved here."

### Status — what happened

Used on **data only**: outcome pills, result panels, step marks. Never on
chrome, so status and actor never compete.

| token | hex | role |
|---|---|---|
| `--ok` | `#5FB88A` | success; a business outcome the caller asked for |
| `--warn` | `#D99A4E` | recoverable, escalated, draft, fragile |
| `--bad` | `#DD6E5A` | hard failure, refused by policy, irreversible |
| `--info` | `#6E9BF2` | in progress, informational |

`--warn` and `--human` are the same value on purpose — both mean "needs
attention from a person."

### Rules

- Interactions **increase** contrast. Hover raises the surface, never dims it.
- On the stage (which shows a light legacy app), tint the surrounding border
  toward the actor hue rather than using a neutral — the boundary between
  our chrome and their app must be unmistakable.
- Irreversible is the only thing allowed to use `--bad` outside a failure.

---

## 3. Type

One family. Distinctiveness comes from the scale and the spacing, not from a
novelty face — and a bundled webfont is a load failure waiting to happen in a
desktop app that must work offline.

- **UI**: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
- **Data**: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace` — used
  for anything a person might need to *compare or copy*: identifiers, targets,
  values, versions, token counts.

| step | size / line | weight | use |
|---|---|---|---|
| `display` | 24 / 1.2 | 600 | start-screen headline only |
| `title` | 19 / 1.3 | 600 | view title |
| `strong` | 15 / 1.45 | 550 | capability name, result heading |
| `body` | 13 / 1.55 | 400 | default |
| `dense` | 12 / 1.5 | 400 | event feed, table data |
| `label` | 11 / 1.4 | 600 | uppercase, `0.08em` tracking, `--ink-3` |

Rules, from the Vercel guidelines:

- Buttons and headings use **Title Case**. Sentence case in prose.
- `font-variant-numeric: tabular-nums` wherever digits are compared —
  token counts, timings, balances, version numbers.
- Placeholders end with an ellipsis to signal emptiness.
- Never letter-space lowercase body text.

---

## 4. Space and shape

4px base, 8px rhythm. Spacing is `4 · 8 · 12 · 16 · 24 · 32 · 48`.

- `radius-sm` **4px** — pills, chips, inputs, buttons
- `radius` **6px** — cards, panels
- Nothing larger. Rounded-everything reads as a template.
- Hairlines are 1px `--line`; interactive borders 1px `--line-2`.
- No shadows except on things that genuinely float (drawer, popover), and then
  only as a large soft cast, never a glow.
- **No dead zones**: a label and its control share one hit target.

---

## 5. Components

### Control badge
The loudest element. A dot plus the holder in `label` type, tinted by actor,
on a tinted surface. Present at all times — there is no state where "who is
driving" is unanswered, including mid-transfer, which reads `HANDING OVER`.

### Stage
The live session. A 1px border tinted by the current actor, so the frame
itself says who is driving. When the operator holds control the border is
`--human` and a persistent hint sits below it. Never a glow.

### Event feed
One row per event: a mark, the actor's rail tint, and a **sentence**. Not JSON.
Agent rows carry a cool left rail; operator rows carry a warm one and a raised
surface, so a handoff reads as a visible seam in the history.

Marks are glyphs, never emoji: `✓` done · `◆` read · `●` finished ·
`!` needs a human · `✗` refused · `↻` recovered · `·` incidental.

### Capability card
A capability is an **object**, not a form. The card states what it is before
it offers anything to do: id, version and approval, one-line description, its
typed contract (inputs → outputs, plus the outcomes it may return instead), and
only then a Run control.

Approval state is a pill: `approved` `--ok` · `draft` `--warn` ·
`incomplete` `--bad`.

### Buttons
Default is quiet: `--surface-2` with a `--line-2` border. One primary per view.
- Loading keeps its label and adds a spinner. It never becomes "Loading…".
- Never pre-disabled — disabled only while a request is in flight.
- Destructive or irreversible actions take `--bad` on the border and label,
  never a filled red block.

### States
Every surface designs four: **empty**, **loading**, **populated**, **error**.
An empty catalog explains how to fill it and links to the action. No dead ends.

---

## 6. Motion

Motion explains cause and effect. Nothing announces itself.

- `120ms ease-out` for state changes; `180ms` for the drawer.
- Never `transition: all` — list the properties.
- No entrance animations on data. A row that fades in is a row you can't scan.
- Respect `prefers-reduced-motion`.

---

## 7. The one thing to get right

A person watching this should be able to answer, without clicking:

1. **Who is driving?**
2. **Is this the model figuring it out, or an artifact replaying?**
3. **What has it already done that cannot be undone?**

If a change makes any of those harder to answer, it is the wrong change.
