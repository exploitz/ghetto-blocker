import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FiltersEngine, adsAndTrackingLists, adsLists, fullLists } from '@ghostery/adblocker';
import type { GhettoBlockerConfig } from './config';

/**
 * Engine build options. `loadExtendedSelectors` keeps the procedural
 * cosmetic filters (`:has-text()`, `:upward()`, nested `:has()` ...) that
 * plain CSS cannot express; the extension evaluates them in-page.
 */
const ENGINE_OPTIONS = { loadExtendedSelectors: true } as const;

/** Tracker-only lists (EasyPrivacy + uBO privacy): what AdNauseam mode keeps blocking while ads are let through. */
export const PRIVACY_LISTS = adsAndTrackingLists.filter((url) => !adsLists.includes(url));

export interface Engines {
  /** Everything: ads + trackers + cookie notices + annoyances. */
  base: FiltersEngine;
  /** Trackers only. */
  privacy: FiltersEngine;
  /** When the lists were downloaded (epoch ms). */
  builtAt: number;
}

/**
 * Load both engines from the on-disk caches when fresh, otherwise download
 * the lists from Ghostery's CDN and cache them.
 */
export async function loadEngines(config: GhettoBlockerConfig): Promise<Engines> {
  const [base, privacy] = await Promise.all([
    tryLoadCachedEngine(config.enginePath, config.engineTtlMs),
    tryLoadCachedEngine(config.privacyEnginePath, config.engineTtlMs),
  ]);
  if (base && privacy) {
    return { base: base.engine, privacy: privacy.engine, builtAt: Math.min(base.builtAt, privacy.builtAt) };
  }
  return buildEngines(config);
}

/** Download the lists now and replace both caches. */
export async function buildEngines(config: GhettoBlockerConfig): Promise<Engines> {
  console.log('[engine] Downloading filter lists...');
  const [base, privacy] = await Promise.all([
    FiltersEngine.fromLists(fetch, fullLists, ENGINE_OPTIONS),
    FiltersEngine.fromLists(fetch, PRIVACY_LISTS, ENGINE_OPTIONS),
  ]);
  await Promise.all([persistEngine(base, config.enginePath), persistEngine(privacy, config.privacyEnginePath)]);
  console.log('[engine] Filter engines built and cached.');
  return { base, privacy, builtAt: Date.now() };
}

async function tryLoadCachedEngine(
  path: string,
  ttlMs: number,
): Promise<{ engine: FiltersEngine; builtAt: number } | null> {
  try {
    const info = await stat(path);
    const ageMs = Date.now() - info.mtimeMs;
    if (ageMs > ttlMs) {
      console.log(`[engine] ${path} is stale; refreshing.`);
      return null;
    }
    const buf = await readFile(path);
    const engine = FiltersEngine.deserialize(new Uint8Array(buf));
    if (engine.config.loadExtendedSelectors !== ENGINE_OPTIONS.loadExtendedSelectors) {
      // Built by an older release with different parse options; the cache
      // cannot be upgraded in place.
      console.log(`[engine] ${path} was built with outdated options; rebuilding.`);
      return null;
    }
    console.log(`[engine] Loaded ${path} (${Math.round(buf.length / 1024)} KiB, age ${formatAge(ageMs)}).`);
    return { engine, builtAt: info.mtimeMs };
  } catch (err) {
    // Cache miss, or a version mismatch from deserialize() across library
    // upgrades - both mean "rebuild from source", not a fatal error.
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[engine] No usable cache at ${path} (${message}); rebuilding.`);
    return null;
  }
}

async function persistEngine(engine: FiltersEngine, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, engine.serialize());
}

function formatAge(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  return hours < 24 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}
