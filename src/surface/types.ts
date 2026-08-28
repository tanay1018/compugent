import type { Role, TargetDescriptor, ResolutionTier } from '../schema/target.js';

/**
 * EPHEMERAL TYPES — none of this is ever persisted.
 *
 * This is the other half of the seam. `Observation` is whatever a Surface can
 * see *right now*; `TargetDescriptor` (schema/target.ts) is what a saved
 * artifact remembers. Keeping them in separate files is the point: if a
 * platform detail can reach a stored artifact, the artifact stops being
 * portable across surfaces and tenants.
 */

export type SurfaceKind = 'web' | 'desktop';

/**
 * One perceivable control or piece of content, normalised from whatever the
 * platform exposes (web AX tree via CDP, macOS AXUIElement, Windows UIA).
 */
export interface UINode {
  /** Stable only within THIS observation. Never persisted. */
  ref: number;
  role: Role;
  /** Accessible name. Frequently empty on legacy surfaces — see anchorText. */
  name: string;
  value: string;
  states: ReadonlyArray<'disabled' | 'focused' | 'checked' | 'expanded' | 'readonly' | 'required'>;
  /** Named frame/window this node lives in. */
  frame: string;
  /**
   * Recovered label for a control the platform exposes anonymously — the text
   * in the adjacent cell, the preceding sibling, and so on. This is what makes
   * an unnamed legacy input addressable at all.
   */
  anchorText?: string;
  anchorRelation?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  /** Opaque platform handle (backendNodeId, AXUIElementRef, …). */
  handle: unknown;
}

export interface FrameInfo {
  id: string;
  name: string;
  url?: string;
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
 * Resolution is a THREE-way outcome, not two.
 *
 * `ambiguous` exists as a first-class failure because the common recorder bug
 * is silently taking the first of several matches. In a bank back-office that
 * means acting on the wrong member's row. A descriptor that matches three
 * controls is an under-specified descriptor — an artifact defect to surface,
 * not a coin flip to resolve at runtime.
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
 * The surface abstraction.
 *
 * Everything above the Surface — the artifact schema, the replay engine, the
 * policy layer, the escalation state machine — is written against this
 * interface and nothing else. Adding a desktop surface should require
 * implementing this and changing nothing else. That claim is the whole
 * heterogeneity story, so the interface is deliberately small.
 */
export interface Surface {
  readonly kind: SurfaceKind;

  /** Snapshot the current state. */
  observe(): Promise<Observation>;

  /**
   * Locate a described control within an observation.
   *
   * Intentionally PURE and synchronous: it takes an Observation rather than
   * touching the live surface. Anchor matching and ambiguity detection are the
   * subtlest logic in the system, and this signature makes them unit-testable
   * against fixture observations with no browser and no target app running.
   */
  resolve(observation: Observation, target: TargetDescriptor): ResolveResult;

  /** Perform an action against a node from the given observation. */
  act(observation: Observation, node: UINode, action: Action): Promise<void>;

  /** Richer evidence signal, captured on failure and at checkpoints. */
  screenshot(): Promise<Buffer>;

  navigate(url: string): Promise<void>;

  // --- Human-in-the-loop handoff -----------------------------------------
  // The session must outlive the automation that started it: a human takes
  // over THIS session, not a fresh one.

  /** Begin streaming frames to an operator console. */
  startStream(onFrame: (jpegBase64: string) => void): Promise<void>;
  stopStream(): Promise<void>;

  /**
   * Inject operator input into the live session. Callers must gate this on the
   * control token — the Surface deliberately does not police who is driving,
   * because that decision belongs to the escalation state machine.
   */
  dispatchRawInput(event: RawInput): Promise<void>;

  close(): Promise<void>;
}
