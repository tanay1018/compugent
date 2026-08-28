import { z } from 'zod';

/**
 * PERSISTED TYPES — these cross the boundary into saved artifacts.
 *
 * The seam this file defines: a recorded flow never stores a CSS selector, an
 * XPath, or a pixel coordinate. It stores a *description of intent* — "the
 * textbox in the same row as the text 'Member ID'" — which each Surface
 * implementation resolves in its own way. That is what lets one artifact
 * target a modern web app, a frameset legacy app, or (by design) a desktop
 * window without the schema changing.
 */

/**
 * Normalised control roles. Deliberately a small, surface-agnostic set: each
 * value maps onto web ARIA, macOS AX (AXRole) and Windows UIA (ControlType).
 * Anything a Surface cannot classify becomes `unknown` rather than leaking a
 * platform-specific role into a persisted artifact.
 */
export const Role = z.enum([
  'button', 'link', 'textbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'tab', 'menuitem', 'heading', 'text',
  'cell', 'row', 'table', 'dialog', 'alert', 'form', 'image', 'unknown',
]);
export type Role = z.infer<typeof Role>;

/**
 * How a control is identified relative to *other* content.
 *
 * This is the load-bearing idea for legacy surfaces. Measured against a
 * table-layout back-office screen, the accessibility tree exposes input
 * fields with NO accessible name at all — the only thing identifying the
 * field is the label text sitting in the adjacent cell. `inSameRowAs` is
 * therefore a primary targeting strategy, not a fallback.
 */
export const AnchorRelation = z.enum([
  'inSameRowAs',   // legacy table layout: label in a sibling <td> / adjacent AX cell
  'inSameCellAs',
  'precededBy',    // nearest preceding text-bearing sibling
  'follows',
  'labelledBy',    // a real label association, when the app bothers to have one
  'within',        // inside a named container (fieldset, group, panel)
]);
export type AnchorRelation = z.infer<typeof AnchorRelation>;

export const Anchor = z.object({
  relation: AnchorRelation,
  /** Visible text of the anchoring element, normalised for whitespace/case. */
  text: z.string().min(1),
  /** Optional role of the anchor, when it disambiguates. */
  role: Role.optional(),
});
export type Anchor = z.infer<typeof Anchor>;

/** How strictly an accessible name must match. */
export const NameMatch = z.enum(['exact', 'normalized', 'contains', 'regex']);

/**
 * Narrows where resolution may look. `frame` is a *name*, never an index —
 * frame ordering is not stable across app versions, names generally are.
 */
export const Scope = z.object({
  frame: z.string().optional(),
  withinRole: Role.optional(),
  withinName: z.string().optional(),
});

/**
 * Lower-confidence strategies, tried only after the semantic descriptor
 * fails. Ordered most- to least-trustworthy. Every use is recorded in the run
 * log, because a replay that succeeded only via `visual` is a replay whose
 * artifact needs review.
 */
export const Fallback = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('css'), value: z.string() }),
  z.object({ kind: z.literal('xpath'), value: z.string() }),
  z.object({ kind: z.literal('text'), value: z.string() }),
  /** Last resort for surfaces with no accessibility layer at all (Citrix/VDI,
   *  green-screen terminals). Designed, not built — see REPORT.md §4. */
  z.object({
    kind: z.literal('visual'),
    ocrText: z.string().optional(),
    offsetFromAnchor: z.object({ dx: z.number(), dy: z.number() }).optional(),
  }),
]);

export const ResolutionTier = z.enum(['name', 'anchor', 'fallback', 'visual']);
export type ResolutionTier = z.infer<typeof ResolutionTier>;

/**
 * How a single control is located at replay time.
 *
 * Invariant: a descriptor must carry either an accessible `name` or an
 * `anchor`. A bare role ("some button somewhere") is never a valid target —
 * it is precisely the kind of under-specified locator that produces a replay
 * which silently clicks the wrong thing.
 */
export const TargetDescriptor = z
  .object({
    role: Role,
    name: z.string().optional(),
    nameMatch: NameMatch.default('normalized'),
    anchor: Anchor.optional(),
    scope: Scope.optional(),
    /**
     * Disambiguates a *legitimately* repeating control (row 3 of a results
     * table). Absent means "exactly one match is required" — see the
     * ambiguity rule in surface/types.ts.
     */
    ordinal: z.number().int().nonnegative().optional(),
    fallbacks: z.array(Fallback).default([]),
    provenance: z
      .object({
        discoveredAt: z.string().datetime().optional(),
        /** The model's own justification, captured during discovery. */
        rationale: z.string().optional(),
        resolvedVia: ResolutionTier.optional(),
      })
      .optional(),
  })
  .refine((d) => d.name !== undefined || d.anchor !== undefined, {
    message: 'TargetDescriptor requires a name or an anchor; role alone is not targetable',
  });

export type TargetDescriptor = z.infer<typeof TargetDescriptor>;
