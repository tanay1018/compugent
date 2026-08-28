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

  versions(id: string): number[] {
    const dir = this.dirFor(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  load(id: string, version?: number): CapabilityArtifact {
    const v = version ?? this.versions(id).at(-1);
    if (v === undefined) throw new Error(`no artifact found for "${id}"`);
    const raw = readFileSync(join(this.dirFor(id), `v${v}.json`), 'utf8');
    // Parsed, not cast: a stored artifact is untrusted input like any other.
    return CapabilityArtifact.parse(JSON.parse(raw));
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
