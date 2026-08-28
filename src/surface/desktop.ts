import type {
  Surface, SurfaceKind, Observation, UINode, Action, ResolveResult, RawInput,
} from './types.js';
import type { TargetDescriptor } from '../schema/target.js';

/**
 * Desktop surface — DESIGNED, NOT IMPLEMENTED. See REPORT.md §4.
 *
 * This file exists so the heterogeneity claim can be checked rather than
 * taken on faith: every method a desktop driver would need is present with
 * its real signature, and none of them required changing `Surface`,
 * `TargetDescriptor`, or the artifact schema.
 *
 * How it would be built:
 *
 *  - Perception. macOS AXUIElement (`AXRole`, `AXTitle`, `AXValue`,
 *    `AXChildren`) or Windows UIA (`ControlType`, `Name`, `AutomationId`)
 *    walked into the same UINode shape. The role vocabulary in
 *    schema/target.ts was chosen to map onto all three platforms.
 *
 *  - Anchoring. The legacy-web problem recurs verbatim: Win32/Swing dialogs
 *    routinely expose unlabelled edit controls whose only identity is the
 *    static text to their left. `inSameRowAs` becomes geometric adjacency
 *    (nearest static text within the same horizontal band) instead of a table
 *    walk — same descriptor, different resolver.
 *
 *  - Process boundary. Node has no credible AX bindings, so this would run
 *    out-of-process: a small Python (pyobjc) or C# (UIAutomation) driver
 *    speaking newline-delimited JSON-RPC over stdio. That boundary is the
 *    reason `Surface` is coarse-grained and fully async — every method here
 *    is already one round trip.
 *
 *  - Handoff. Strictly simpler than the web case: the window is already on
 *    the operator's screen, so `startStream` is a screencapture loop and
 *    control transfer is "stop synthesising events" rather than a proxy.
 *
 * Cut deliberately: it needs an OS-specific driver plus an accessibility
 * permission grant, which buys reviewer friction rather than insight. The
 * brief states desktop support is not expected.
 */
export class DesktopSurface implements Surface {
  readonly kind: SurfaceKind = 'desktop';

  constructor(private readonly opts: { app: string; driverPath?: string }) {}

  private notImplemented(method: string): never {
    throw new Error(
      `DesktopSurface.${method}() is not implemented (target: ${this.opts.app}). ` +
        `The surface abstraction is real; the OS driver is a documented cut — see REPORT.md §4.`,
    );
  }

  observe(): Promise<Observation> { this.notImplemented('observe'); }
  resolve(_o: Observation, _t: TargetDescriptor): ResolveResult { this.notImplemented('resolve'); }
  act(_o: Observation, _n: UINode, _a: Action): Promise<void> { this.notImplemented('act'); }
  screenshot(): Promise<Buffer> { this.notImplemented('screenshot'); }
  navigate(_url: string): Promise<void> { this.notImplemented('navigate'); }
  startStream(_cb: (f: string) => void): Promise<void> { this.notImplemented('startStream'); }
  stopStream(): Promise<void> { this.notImplemented('stopStream'); }
  dispatchRawInput(_e: RawInput): Promise<void> { this.notImplemented('dispatchRawInput'); }
  close(): Promise<void> { return Promise.resolve(); }
}
