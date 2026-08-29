import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityArtifact } from '../schema/artifact.js';

/**
 * Artifacts on disk, versioned by file.
 *
 * Deliberately not a database. Artifacts are reviewable objects that belong in
 * version control next to the code that consumes them — a diff between v1 and
 * v2 of a capability is exactly what a reviewer wants to look at, and that is
 * a thing git already does well. Swapping this for a real store later touches
 * one file.
 */
export class ArtifactStore {
  constructor(private readonly root = 'artifacts') {
    mkdirSync(this.root, { recursive: true });
  }

  private dirFor(id: string): string {
    return join(this.root, id);
  }

  save(a: CapabilityArtifact): string {
    const dir = this.dirFor(a.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `v${a.version}.json`);
    if (existsSync(path)) {
      throw new Error(`${a.id} v${a.version} already exists — bump the version rather than overwriting a reviewed artifact`);
    }
    writeFileSync(path, JSON.stringify(a, null, 2));
    return path;
  }

  /**
   * The next free version for an id.
   *
   * Re-recording an existing capability is the normal case, not an error --
   * a flow changed, or a run was redone on a different tenant. The store still
   * refuses to OVERWRITE a reviewed artifact; what it should not do is make
   * re-recording feel like a failure.
   */
  nextVersion(id: string): number {
    return (this.versions(id).at(-1) ?? 0) + 1;
  }

  versions(id: string): number[] {
    const dir = this.dirFor(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** Read one specific version, without any preference logic. */
  private read(id: string, v: number): CapabilityArtifact {
    const raw = readFileSync(join(this.dirFor(id), `v${v}.json`), 'utf8');
    // Parsed, not cast: a stored artifact is untrusted input like any other.
    return CapabilityArtifact.parse(JSON.parse(raw));
  }

  /**
   * Which version a caller gets.
   *
   * NOT simply the highest. An approved artifact outranks any later draft,
   * because re-recording is how a capability gets worse as well as better:
   * a fresh run on a cheaper model produced a flow that clicked Search before
   * typing anything, compiled cleanly as the next version, and would have
   * silently replaced a working capability for every caller.
   *
   * Highest approved if one exists; otherwise highest overall, so a
   * never-reviewed capability still works.
   */
  load(id: string, version?: number): CapabilityArtifact {
    const all = this.versions(id);
    if (version !== undefined) return this.read(id, version);
    if (!all.length) throw new Error(`no artifact found for "${id}"`);

    const approved = all.filter((v) => {
      try { return this.read(id, v).approval === 'approved'; } catch { return false; }
    });
    const pick = approved.at(-1) ?? all.at(-1)!;
    return this.read(id, pick);
  }

  /** Promote a reviewed version. The only way to reach `approved`. */
  approve(id: string, version: number): CapabilityArtifact {
    const a = this.read(id, version);
    if (a.approval === 'incomplete') {
      throw new Error(`${id} v${version} is incomplete — it has no checkpoint and cannot be approved`);
    }
    const next = CapabilityArtifact.parse({ ...a, approval: 'approved' });
    writeFileSync(join(this.dirFor(id), `v${version}.json`), JSON.stringify(next, null, 2));
    return next;
  }

  list(): Array<{ id: string; version: number; name: string; approval: string }> {
    if (!existsSync(this.root)) return [];
    const out: Array<{ id: string; version: number; name: string; approval: string }> = [];
    for (const id of readdirSync(this.root)) {
      const v = this.versions(id).at(-1);
      if (v === undefined) continue;
      const a = this.load(id, v);
      out.push({ id: a.id, version: a.version, name: a.name, approval: a.approval });
    }
    return out;
  }
}
