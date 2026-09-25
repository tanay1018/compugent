import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { redactText } from '../policy/allowlist.js';

/**
 * Run log shared by automation and operator events, which differ only by
 * `actor`, so a run can be reconstructed across a handoff.
 */
export type Actor = 'agent' | 'operator' | 'system';

export interface RunEvent {
  seq: number;
  ts: string;
  actor: Actor;
  kind: string;
  detail?: Record<string, unknown>;
  /** Relative path to a captured frame, when one was worth keeping. */
  screenshot?: string;
}

/** Values are redacted before they are written, not afterwards. */
function scrub(v: unknown): unknown {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x)]));
  }
  return v;
}

export class RunLog {
  private seq = 0;
  readonly events: RunEvent[] = [];
  readonly dir: string;

  constructor(baseDir: string, runId: string) {
    // DATA_DIR relocates evidence for the packaged app. An absolute baseDir is used as-is.
    this.dir = isAbsolute(baseDir)
      ? join(baseDir, runId)
      : join(process.env.DATA_DIR ?? '.', baseDir, runId);
    mkdirSync(join(this.dir, 'screenshots'), { recursive: true });
  }

  append(actor: Actor, kind: string, detail?: Record<string, unknown>, screenshot?: string): RunEvent {
    const e: RunEvent = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      actor,
      kind,
      ...(detail ? { detail: scrub(detail) as Record<string, unknown> } : {}),
      ...(screenshot ? { screenshot } : {}),
    };
    this.events.push(e);
    appendFileSync(join(this.dir, 'run.jsonl'), JSON.stringify(e) + '\n');
    return e;
  }

  /** Screenshot. Taken every step in discovery; in replay at checkpoints and on failure. */
  saveScreenshot(buf: Buffer, label: string): string {
    const rel = join('screenshots', `${String(this.seq).padStart(3, '0')}-${label}.png`);
    writeFileSync(join(this.dir, rel), buf);
    return rel;
  }

  writeJson(name: string, data: unknown): void {
    writeFileSync(join(this.dir, name), JSON.stringify(data, null, 2));
  }
}
