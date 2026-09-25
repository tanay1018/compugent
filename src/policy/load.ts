import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolicyConfig, defaultPolicy } from './allowlist.js';

export interface LoadedPolicy {
  policy: PolicyConfig;
  /** Where the policy came from, for printing at the start of a run. */
  source: string;
}

/**
 * Load the allowlist from POLICY_FILE, or `policy.json` under DATA_DIR (the
 * repo root when run from source). The file is validated, so a malformed
 * policy stops the run instead of being ignored.
 *
 * With no policy file (the packaged desktop app on first run) the policy is
 * the entry origin only, which is what the user typed into the app.
 */
export function loadPolicy(entryUrl: string): LoadedPolicy {
  const path = process.env.POLICY_FILE ?? join(process.env.DATA_DIR ?? '.', 'policy.json');
  if (!existsSync(path)) {
    return { policy: defaultPolicy(new URL(entryUrl).origin), source: 'entry origin only (no policy.json)' };
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const result = PolicyConfig.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid policy file ${path}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return { policy: result.data, source: path };
}
