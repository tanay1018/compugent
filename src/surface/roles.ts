import { Role } from '../schema/target.js';

/**
 * Platform role -> normalised role.
 *
 * One app may mark a search field `searchbox` and another `textbox`; mapping
 * both to one role lets one recording serve both. The vocabulary is coarse and
 * every value has a counterpart in macOS AX and Windows UIA.
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

/** Roles a user can act on. */
export const ACTIONABLE: ReadonlySet<Role> = new Set<Role>([
  'button', 'link', 'textbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'tab', 'menuitem', 'option',
]);

/** Non-interactive roles kept for context and assertions. Everything else is dropped. */
export const INFORMATIONAL: ReadonlySet<Role> = new Set<Role>([
  'heading', 'text', 'cell', 'row', 'alert', 'dialog',
]);
