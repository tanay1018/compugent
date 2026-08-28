import { Role } from '../schema/target.js';

/**
 * Platform role -> normalised role.
 *
 * Normalisation is load-bearing, not cosmetic: one app marks its search field
 * `searchbox` and another marks the same control `textbox`. If the raw
 * platform role reached the artifact, those two would need separate
 * recordings. The vocabulary is deliberately coarse — it only needs to be
 * fine enough to disambiguate targets, and every value has a counterpart in
 * macOS AX and Windows UIA.
 */
const WEB_ROLE_MAP: Record<string, Role> = {
  button: 'button', link: 'link',
  textbox: 'textbox', searchbox: 'textbox', spinbutton: 'textbox',
  combobox: 'combobox', listbox: 'listbox', option: 'option',
  checkbox: 'checkbox', switch: 'checkbox', radio: 'radio',
  tab: 'tab', menuitem: 'menuitem', menuitemcheckbox: 'menuitem',
  heading: 'heading',
  StaticText: 'text', text: 'text', paragraph: 'text', LineBreak: 'text',
  cell: 'cell', gridcell: 'cell', columnheader: 'cell', rowheader: 'cell',
  row: 'row', table: 'table', grid: 'table',
  dialog: 'dialog', alertdialog: 'dialog',
  alert: 'alert', status: 'alert',
  form: 'form', img: 'image', image: 'image',
};

export const normaliseWebRole = (raw: string): Role => WEB_ROLE_MAP[raw] ?? 'unknown';

/** Roles a user can act on. Used to decide which nodes deserve anchor
 *  enrichment — the expensive part of observation. */
export const ACTIONABLE: ReadonlySet<Role> = new Set<Role>([
  'button', 'link', 'textbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'tab', 'menuitem', 'option',
]);

/** Roles worth keeping for context and assertions even though you cannot
 *  click them. Everything else is dropped to keep observations small. */
export const INFORMATIONAL: ReadonlySet<Role> = new Set<Role>([
  'heading', 'text', 'cell', 'row', 'alert', 'dialog',
]);
