import { z } from 'zod';

/**
 * Persisted target types.
 *
 * A recorded flow stores a description ("the textbox in the same row as
 * 'Member ID'"), never a CSS selector, XPath or coordinate. Each Surface
 * resolves descriptions its own way, so the schema is not tied to the web.
 */

/**
 * Normalised control roles. Each maps onto web ARIA, macOS AX (AXRole) and
 * Windows UIA (ControlType). Anything else becomes `unknown`.
 */
export const Role = z.enum([
  'button', 'link', 'textbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'tab', 'menuitem', 'heading', 'text',
  'cell', 'row', 'table', 'dialog', 'alert', 'form', 'image', 'unknown',
]);
export type Role = z.infer<typeof Role>;

/**
 * How a control is identified relative to nearby content. On table-layout
 * screens inputs often have no accessible name, so `inSameRowAs` is a primary
 * strategy, not a fallback.
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

/** Narrows where resolution may look. `frame` is a name, not an index, since frame order is not stable. */
export const Scope = z.object({
  frame: z.string().optional(),
  withinRole: Role.optional(),
  withinName: z.string().optional(),
});

/**
 * Lower-confidence strategies, tried in order after the descriptor fails.
 * Every use is logged, since an artifact that relies on them needs review.
 */
export const Fallback = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('css'), value: z.string() }),
  z.object({ kind: z.literal('xpath'), value: z.string() }),
  z.object({ kind: z.literal('text'), value: z.string() }),
  /** For surfaces with no accessibility layer (Citrix/VDI, terminals). Not implemented; see REPORT.md §4. */
  z.object({
    kind: z.literal('visual'),
    ocrText: z.string().optional(),
    offsetFromAnchor: z.object({ dx: z.number(), dy: z.number() }).optional(),
  }),
]);

export const ResolutionTier = z.enum(['name', 'anchor', 'fallback', 'visual']);
export type ResolutionTier = z.infer<typeof ResolutionTier>;

/**
 * How a single control is located at replay time. Must have a `name` or an
 * `anchor`; a bare role is too under-specified to target safely.
 */
export const TargetDescriptor = z
  .object({
    role: Role,
    /** May contain `{{param}}` placeholders, substituted at replay time. */
    name: z.string().optional(),
    nameMatch: NameMatch.default('normalized'),
    anchor: Anchor.optional(),
    scope: Scope.optional(),
    /** Picks one of several matches (e.g. row 3). Absent means exactly one match is required. */
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
