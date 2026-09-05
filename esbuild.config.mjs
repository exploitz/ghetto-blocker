/**
 * esbuild.config.mjs -- compile the Electron main process
 *
 * Two bundles:
 *
 *   1. Electron main process
 *   - Entry point: electron/main.ts (and its imports from src/)
 *   - Output:      dist/electron-main.cjs  (CommonJS -- Electron requires CJS for main)
 *   - Platform:    node  (built-in modules are external; no browser shims)
 *   - packages:    external  -- all node_modules stay as require() calls;
 *                  electron-builder will bundle production node_modules separately
 *                  so we avoid the dynamic-require issues in http-mitm-proxy/node-forge.
 *
 *   2. Extension content script
 *   - Entry point: extension-src/cosmetics.ts
 *   - Output:      extension/cosmetics.js  (self-contained IIFE; bundles the
 *                  @ghostery DOM monitor + extended-selector evaluator)
 *
 * Usage:
 *   node esbuild.config.mjs          # production build
 *   node esbuild.config.mjs --watch  # rebuild on save during development
 */

import { build, context } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const electronOpts = {
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/electron-main.cjs',
  // All npm packages stay as require() in the output -- never inlined.
  // This avoids the dynamic-require breakage in http-mitm-proxy and node-forge.
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const extensionOpts = {
  entryPoints: ['extension-src/cosmetics.ts'],
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  outfile: 'extension/cosmetics.js',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  for (const opts of [electronOpts, extensionOpts]) {
    const ctx = await context(opts);
    await ctx.watch();
  }
  console.log('[esbuild] watching...');
} else {
  await Promise.all([build(electronOpts), build(extensionOpts)]);
}
