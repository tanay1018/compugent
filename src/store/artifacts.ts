import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityArtifact } from '../schema/artifact.js';

/**
 * Artifacts on disk, one JSON file per version. Files rather than a database
 * so versions can be reviewed and diffed in git.
 */
export class ArtifactStore {
  /** DATA_DIR relocates the store (the packaged app cannot write inside its bundle). */
  constructor(private readonly root = join(process.env.DATA_DIR ?? '.', 'artifacts')) {
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

  /** The next free version number for an id. */
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
    // Parse rather than cast: stored files are untrusted input.
    return CapabilityArtifact.parse(JSON.parse(raw));
  }

  /**
   * The version a caller gets: the highest approved one, else the highest
   * overall. This stops a newer, unreviewed draft from replacing a working
   * capability.
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
