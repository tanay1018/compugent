/**
 * Bundle the scripts the desktop app shells out to.
 *
 * A packaged app has no npx, no tsx and no TypeScript sources, so each runner
 * becomes one self-contained .mjs that Electron's own node can execute. ESM
 * rather than CJS because several of these use top-level await.
 *
 * playwright stays external: it resolves its browser binaries relative to its
 * own package directory, so it has to remain a real node_modules dependency
 * (electron-builder unpacks it from the asar for the same reason).
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('build/runners', { recursive: true, force: true });

await build({
  entryPoints: ['scripts/watch.ts', 'scripts/replay.ts', 'scripts/compile.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'build/runners',
  outExtension: { '.js': '.mjs' },
  external: ['playwright', 'electron'],
  // esbuild's ESM output has no `require`, but bundled dependencies still
  // reach for it. This is the documented shim.
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  logLevel: 'warning',
});

console.log('runners bundled → build/runners');
