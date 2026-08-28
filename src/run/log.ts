import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactText } from '../policy/allowlist.js';

/**
 * One log, both actors.
 *
 * Automation events and human events share a shape and differ only by
 * `actor`. That is what makes a run reconstructable across a handoff: the
 * operator's actions are not a side channel, they are the same history. It is
 * also what 3.6 asks for directly — "record what the human did" — and what a
 * regulated environment needs for audit.
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

/** Redaction happens on the way IN. Scrubbing a log after the fact is theatre:
 *  the value has already been written to disk. */
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
    this.dir = join(baseDir, runId);
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

  /** Richer failure signal (3.5). Cheap enough to keep at every step boundary
   *  during discovery; replay keeps them at checkpoints and on failure. */
  saveScreenshot(buf: Buffer, label: string): string {
    const rel = join('screenshots', `${String(this.seq).padStart(3, '0')}-${label}.png`);
    writeFileSync(join(this.dir, rel), buf);
    return rel;
  }

  writeJson(name: string, data: unknown): void {
    writeFileSync(join(this.dir, name), JSON.stringify(data, null, 2));
  }
}
