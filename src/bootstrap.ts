/**
 * bootstrap.ts -- shared startup used by both headless (src/index.ts) and
 * Electron (electron/main.ts) entry points.
 *
 * Loads the adblocker engine, creates the RuntimeContext, and starts both
 * the MITM proxy and the local control server. Returns a handle the caller
 * uses to query settings and shut everything down cleanly.
 */

import http from 'node:http';
import { config } from './config.js';
import { createControlServer } from './control-server.js';
import { buildEngines, loadEngines } from './engine.js';
import { installSharedLeafKey } from './leaf-keys.js';
import { createProxy } from './proxy.js';
import type { RuntimeContext } from './runtime.js';
import { createRuntimeContext } from './runtime.js';
import { loadSettings, loadStats, saveStats } from './state.js';

/** How often the running totals are written to stats.json. */
const STATS_FLUSH_MS = 30_000;

/** Optional startup overrides. */
export interface BootstrapOptions {
  /**
   * Absolute path of the static dashboard directory. Defaults to
   * `<cwd>/public/dashboard` (correct for `npm start`); the packaged Electron
   * app passes its resources path because cwd is arbitrary there.
   */
  dashboardDir?: string;
  /** App version shown in the dashboard (Electron passes app.getVersion()). */
  version?: string;
}

/** Return value of bootstrap(). */
export interface BootstrapResult {
  /** Mutable runtime context (settings, stats, rules). */
  ctx: RuntimeContext;
  /** HTTP server powering the dashboard + REST API. Useful for adding custom routes. */
  controlServer: http.Server;
  /** Stop everything and flush stats -- await before process exit. */
  stop: () => Promise<void>;
}

/**
 * Start the proxy and control server.
 *
 * Throws on startup errors (e.g. EADDRINUSE).  Callers are responsible for
 * translating errors into user-visible messages (console vs. dialog).
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const [engines, settings, stats] = await Promise.all([loadEngines(config), loadSettings(), loadStats()]);
  const ctx = createRuntimeContext({
    baseEngine: engines.base,
    privacyEngine: engines.privacy,
    engineBuiltAt: engines.builtAt,
    rebuildEngines: () => buildEngines(config),
    version: options.version,
    proxyPort: config.proxyPort,
    settings,
    stats,
  });
  await ctx.loadPersistedUserRules();

  // Totals survive restarts: flush periodically and on stop.
  const statsTimer = setInterval(() => {
    void saveStats(stats).catch(() => { /* best-effort */ });
  }, STATS_FLUSH_MS);
  statsTimer.unref();

  installSharedLeafKey();
  const { proxy } = createProxy(ctx);
  const controlServer = createControlServer(ctx, options.dashboardDir);

  // Start control server first (dashboard may already be open).
  const csPort = ctx.settings.controlPort;
  await new Promise<void>((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(csPort, '127.0.0.1', resolve);
  });

  // Start the MITM proxy.
  await new Promise<void>((resolve, reject) => {
    proxy.listen(
      { port: config.proxyPort, host: config.proxyHost, sslCaDir: config.sslCaDir },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });

  async function stop(): Promise<void> {
    clearInterval(statsTimer);
    controlServer.close();
    proxy.close();
    await saveStats(stats).catch(() => { /* best-effort */ });
  }

  return { ctx, controlServer, stop };
}
