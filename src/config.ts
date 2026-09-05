import { join } from 'node:path';
import { dataDir } from './paths.js';

/**
 * Install-level configuration (static, set once at startup).
 *
 * Fields below marked [RUNTIME] will migrate to Settings (src/state.ts) when
 * the proxy is refactored onto RuntimeContext in Task 3.  Until then they
 * remain here so the existing proxy.ts and integration tests keep compiling.
 *
 * After Task 3 the only fields that belong here are the truly static,
 * install-level ones: proxyPort, proxyHost, sslCaDir, enginePath, engineTtlMs.
 * Runtime-mutable fields (paused, injectCosmetics, stripCSP, antiAnalytics,
 * theme, controlPort, autostart, allowlist, bypassHosts) live in Settings.
 */
export interface GhettoBlockerConfig {
  /** Port the filtering proxy listens on. */
  proxyPort: number;
  /** Interface to bind. 127.0.0.1 keeps the proxy local-only. */
  proxyHost: string;
  /** Directory where http-mitm-proxy stores the generated CA + leaf certs. */
  sslCaDir: string;
  /** On-disk path for the cached, serialized filter engine (all lists). */
  enginePath: string;
  /** On-disk path for the cached privacy-lists-only engine (used by AdNauseam mode). */
  privacyEnginePath: string;
  /** Re-download filter lists when the cache is older than this (ms). */
  engineTtlMs: number;
  /** [RUNTIME -> Settings.injectCosmetics] Inject element-hiding CSS into HTML responses. */
  injectCosmetics: boolean;
  /** [RUNTIME -> Settings.stripCSP] Strip Content-Security-Policy on HTML so injected inline CSS/JS can run. */
  stripCSP: boolean;
  /** [RUNTIME -> Settings.bypassHosts] Hosts to pass through completely unfiltered. */
  bypassHosts: string[];
}

export const config: GhettoBlockerConfig = {
  proxyPort: 8080,
  proxyHost: '127.0.0.1',
  sslCaDir: join(dataDir(), 'ca'),
  enginePath: join(dataDir(), 'engine.bin'),
  privacyEnginePath: join(dataDir(), 'privacy.bin'),
  engineTtlMs: 7 * 24 * 60 * 60 * 1000,
  injectCosmetics: true,
  stripCSP: true,
  // Add hosts that misbehave under TLS interception here (cert-pinned apps,
  // banking sites). Matched by exact host or subdomain suffix - e.g. 'chase.com'
  // also covers 'secure.chase.com'. These are never filtered or modified.
  // Bypass hosts are tunneled raw at the CONNECT layer (see proxy.ts): the
  // connection is spliced straight to the origin with no TLS interception, so
  // cert-pinned apps and MITM-sensitive streaming apps behave exactly as they
  // would with no proxy. The runtime default lives in state.ts DEFAULT_SETTINGS.
  bypassHosts: [],
};
