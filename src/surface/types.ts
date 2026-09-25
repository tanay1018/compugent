import type { Role, TargetDescriptor, ResolutionTier } from '../schema/target.js';

/**
 * Ephemeral types, never persisted.
 *
 * `Observation` is what a Surface sees right now; `TargetDescriptor`
 * (schema/target.ts) is what a saved artifact stores. Keeping them apart stops
 * platform details from leaking into artifacts.
 */

export type SurfaceKind = 'web' | 'desktop';

/**
 * One perceivable control or piece of content, normalised from whatever the
 * platform exposes (web AX tree via CDP, macOS AXUIElement, Windows UIA).
 */
export interface UINode {
  /** Stable only within this observation. Never persisted. */
  ref: number;
  role: Role;
  /** Accessible name. Frequently empty on legacy surfaces — see anchorText. */
  name: string;
  value: string;
  states: ReadonlyArray<'disabled' | 'focused' | 'checked' | 'expanded' | 'readonly' | 'required'>;
  /** Named frame/window this node lives in. */
  frame: string;
  /** Nearby label text (adjacent cell, preceding sibling, ...), for controls with no accessible name. */
  anchorText?: string;
  anchorRelation?: string;
  /**
   * The control's input type where available (`password`, `email`, ...).
   * Unlike a label it cannot be omitted, so it is the reliable signal for a
   * secret field.
   */
  inputType?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  /** Opaque platform handle (backendNodeId, AXUIElementRef, …). */
  handle: unknown;
}

export interface FrameInfo {
  id: string;
  name: string;
  url?: string;
}

/**
 * The URL that identifies the screen. In a frameset the top document never
 * navigates, so this uses the frame with the most perceivable nodes.
 */
export function contentLocation(o: Observation): string {
  if (o.frames.length <= 1) return o.location;
  const counts = new Map<string, number>();
  for (const n of o.nodes) counts.set(n.frame, (counts.get(n.frame) ?? 0) + 1);
  let best: string | undefined;
  let bestN = -1;
  for (const f of o.frames) {
    const n = counts.get(f.name) ?? 0;
    if (f.url && n > bestN) { bestN = n; best = f.url; }
  }
  return best ?? o.location;
}

export interface Observation {
  surfaceKind: SurfaceKind;
  capturedAt: string;
  frames: FrameInfo[];
  nodes: UINode[];
  /** Location identifier — a URL for web, a window title for desktop. */
  location: string;
}

export type ActionKind = 'click' | 'type' | 'select' | 'press' | 'navigate' | 'read';

export interface Action {
  kind: ActionKind;
  text?: string;
  key?: string;
  url?: string;
}

/**
 * Resolution result. `ambiguous` is a failure rather than "take the first
 * match", because the first match may be the wrong record's row.
 */
export type ResolveResult =
  | { ok: true; node: UINode; via: ResolutionTier }
  | { ok: false; reason: 'not_found'; tried: ResolutionTier[] }
  | { ok: false; reason: 'ambiguous'; candidates: UINode[] };

/** A raw input event forwarded from a human operator during handoff. */
export type RawInput =
  | { type: 'mouse'; action: 'down' | 'up' | 'move'; x: number; y: number; button?: 'left' | 'right' }
  | { type: 'key'; action: 'down' | 'up'; key: string }
  | { type: 'text'; text: string };

/**
 * The surface abstraction. Schema, replay, policy and handoff code depend only
 * on this interface, so a desktop surface only needs to implement it.
 */
export interface Surface {
  readonly kind: SurfaceKind;

  /** Snapshot the current state. */
  observe(): Promise<Observation>;

  /**
   * Locate a described control within an observation. Pure and synchronous,
   * so it can be tested against fixture observations without a browser.
   */
  resolve(observation: Observation, target: TargetDescriptor, params?: Record<string, unknown>): ResolveResult;

  /** Perform an action against a node from the given observation. */
  act(observation: Observation, node: UINode, action: Action): Promise<void>;

  /** Richer evidence signal, captured on failure and at checkpoints. */
  screenshot(): Promise<Buffer>;

  navigate(url: string): Promise<void>;

  // --- Human-in-the-loop handoff -----------------------------------------
  // An operator takes over the same session the automation was using.

  /** Begin streaming frames to an operator console. */
  startStream(onFrame: (jpegBase64: string) => void): Promise<void>;
  stopStream(): Promise<void>;

  /** Inject operator input. Callers must check the control token first. */
  dispatchRawInput(event: RawInput): Promise<void>;

  close(): Promise<void>;
}
