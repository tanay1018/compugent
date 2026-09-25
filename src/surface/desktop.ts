import type {
  Surface, SurfaceKind, Observation, UINode, Action, ResolveResult, RawInput,
} from './types.js';
import type { TargetDescriptor } from '../schema/target.js';

/**
 * Desktop surface: designed, not implemented. See REPORT.md §4.
 *
 * Every Surface method is present with its real signature and throws. Adding
 * it required no changes to `Surface`, `TargetDescriptor` or the schema.
 *
 * Intended implementation:
 *
 *  - Perception. macOS AXUIElement (`AXRole`, `AXTitle`, `AXValue`,
 *    `AXChildren`) or Windows UIA (`ControlType`, `Name`, `AutomationId`)
 *    walked into the same UINode shape. The role vocabulary in
 *    schema/target.ts was chosen to map onto all three platforms.
 *
 *  - Anchoring. Win32/Swing dialogs often have unlabelled edit controls
 *    identified only by the static text to their left. `inSameRowAs` becomes
 *    geometric adjacency (nearest static text in the same horizontal band).
 *
 *  - Process boundary. Node has no good AX bindings, so a small Python
 *    (pyobjc) or C# (UIAutomation) driver would speak JSON-RPC over stdio.
 *    This is why `Surface` methods are coarse-grained and async.
 *
 *  - Handoff. The window is already on the operator's screen, so
 *    `startStream` is a screen-capture loop and control transfer just stops
 *    synthesising events.
 *
 * Not built because it needs an OS-specific driver and an accessibility
 * permission grant, and the brief does not require desktop support.
 */
export class DesktopSurface implements Surface {
  readonly kind: SurfaceKind = 'desktop';

  constructor(private readonly opts: { app: string; driverPath?: string }) {}

  private notImplemented(method: string): never {
    throw new Error(
      `DesktopSurface.${method}() is not implemented (target: ${this.opts.app}). ` +
        `Desktop surface is not implemented; see REPORT.md §4.`,
    );
  }

  observe(): Promise<Observation> { this.notImplemented('observe'); }
  resolve(_o: Observation, _t: TargetDescriptor, _p?: Record<string, unknown>): ResolveResult { this.notImplemented('resolve'); }
  act(_o: Observation, _n: UINode, _a: Action): Promise<void> { this.notImplemented('act'); }
  screenshot(): Promise<Buffer> { this.notImplemented('screenshot'); }
  navigate(_url: string): Promise<void> { this.notImplemented('navigate'); }
  startStream(_cb: (f: string) => void): Promise<void> { this.notImplemented('startStream'); }
  stopStream(): Promise<void> { this.notImplemented('stopStream'); }
  dispatchRawInput(_e: RawInput): Promise<void> { this.notImplemented('dispatchRawInput'); }
  close(): Promise<void> { return Promise.resolve(); }
}
