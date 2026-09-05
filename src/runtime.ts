import { FiltersEngine, Request } from '@ghostery/adblocker';
import type { Engines } from './engine.js';
import { saveSettings, saveUserRules, loadUserRules } from './state.js';
import type { Settings, Stats, ActivityEvent } from './state.js';

// ---------------------------------------------------------------------------
// RuntimeContext
// ---------------------------------------------------------------------------

/** Parameters for network request matching (matches Request.fromRawDetails). */
export interface MatchParams {
  type: string;
  url: string;
  sourceUrl: string;
}

/** Parameters for cosmetics lookup (a subset of getCosmeticsFilters options). */
export interface CosmeticsParams {
  url: string;
  hostname: string;
  domain: string | undefined;
  /** Class names present in the document; unlocks the class-indexed generic rules. */
  classes?: string[];
  /** Element ids present in the document; unlocks the id-indexed generic rules. */
  ids?: string[];
  /** Link hrefs present in the document; unlocks the href-indexed generic rules. */
  hrefs?: string[];
  /** Include the generic base stylesheet (rules not indexed by class/id/href). Default true. */
  getBaseRules?: boolean;
  /** Include hostname-specific rules. Default true. */
  getRulesFromHostname?: boolean;
  /** Include scriptlet injections. Default true. */
  getInjectionRules?: boolean;
}

/** A procedural (extended) cosmetic rule the engine cannot express as plain CSS; evaluated in-page by the extension. */
export type ExtendedRule = ReturnType<FiltersEngine['getCosmeticsFilters']>['extended'][number];

/** Where the desktop app's self-update stands (surfaced in the dashboard). */
export interface UpdateStatus {
  state: 'unavailable' | 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error';
  /** Version involved: the running one for up-to-date, the new one otherwise. */
  version?: string;
  /** Progress or error text. */
  message?: string;
  checkedAt?: number;
}

/** Self-update plumbing: status the dashboard reads, hooks the Electron layer installs. */
export interface Updates {
  status: UpdateStatus;
  /** Merge a status patch (replaces `message` unless given). */
  setStatus(patch: Partial<UpdateStatus>): void;
  /** Installed by electron/main.ts; absent in headless mode. */
  check?: () => Promise<void>;
  install?: () => void;
}

/** First-run checklist state; the Electron layer fills in what only it can know. */
export interface SetupState {
  /** CA trusted in the Windows root store; null when unknown (headless). */
  caTrusted: boolean | null;
  /** First non-loopback request seen by the proxy this session (epoch ms). */
  trafficSeenAt: number | null;
  /** Last time the extension called the control server (epoch ms, persisted). */
  extensionSeenAt: number | null;
  /** Where the unpacked extension lives, for "load unpacked". */
  extensionDir: string;
  /** Installed by electron/main.ts: run the elevated CA install and re-check. */
  installCa?: () => Promise<void>;
  /** Installed by electron/main.ts: reveal the extension folder in Explorer. */
  openExtensionDir?: () => void;
}

/** Filter-list freshness, plus the error when the last download failed. */
export interface ListsState {
  builtAt: number;
  /** Set while running on empty engines because the lists could not be downloaded. */
  error?: string;
}

/** Combined result of getCosmeticsFilters from base + user engines. */
export interface CosmeticsResult {
  styles: string;
  scripts: string[];
  extended: ExtendedRule[];
}

/** Match result returned by matchRequest - same shape as FiltersEngine.match(). */
export type MatchResult = ReturnType<FiltersEngine['match']>;

export interface RuntimeContext {
  /** Live settings - mutated by updateSettings. */
  settings: Settings;
  /** Live stats. */
  stats: Stats;
  /**
   * Match a network request against base + user engines.
   * Returns the first block/redirect/exception found.
   */
  matchRequest(params: MatchParams): MatchResult;
  /**
   * Return merged cosmetic filters (styles + scripts + extended) from base +
   * user engines. Pass the document's classes/ids/hrefs to also receive the
   * generic rules indexed by those features.
   */
  getCosmetics(params: CosmeticsParams): CosmeticsResult;
  /** Re-parse user rules, persist to disk, and hot-reload the user engine. */
  setUserRules(text: string): Promise<void>;
  /** Return the current in-memory user rules text. */
  getUserRules(): string;
  /** Load previously persisted user rules from disk (call once at startup). */
  loadPersistedUserRules(): Promise<void>;
  /** Merge a settings patch into live settings and persist. */
  updateSettings(patch: Partial<Settings>): Promise<void>;
  /** Push an activity event into the stats ring. */
  recordEvent(ev: Omit<ActivityEvent, 'ts'>): void;
  /**
   * Subscribe to activity events (used by the SSE control server).
   * Returns an unsubscribe function.
   */
  subscribe(listener: (ev: ActivityEvent) => void): () => void;
  /**
   * Subscribe to settings changes (fires after every successful updateSettings).
   * Returns an unsubscribe function.
   */
  subscribeSettings(listener: (settings: Settings) => void): () => void;
  /** When the filter lists currently in use were downloaded (epoch ms). */
  listsBuiltAt(): number;
  /** List freshness and download error, for the dashboard. */
  lists: ListsState;
  /** First-run checklist state. */
  setup: SetupState;
  /**
   * Re-download the filter lists and swap the engines in live. Concurrent
   * calls share one download. Resolves with the new build time.
   */
  updateLists(): Promise<number>;
  /**
   * AdNauseam: announce that the extension is about to fetch this ad
   * click-through URL from `page`, so the proxy lets it through untouched.
   */
  registerPendingClick(url: string, page: string, meta?: { image?: string; title?: string }): void;
  /** Consume a pending click for this URL (returns what was announced), or undefined. */
  takePendingClick(url: string): PendingClick | undefined;
  /** App version string shown in the dashboard. */
  version: string;
  /** Port the filtering proxy listens on (for browser launch flags). */
  proxyPort: number;
  /** Self-update status and hooks. */
  updates: Updates;
}

/** What the extension announced about an ad it is about to click. */
export interface PendingClick {
  page: string;
  image?: string;
  title?: string;
}

/** How long an announced click stays valid before the proxy forgets it. */
const PENDING_CLICK_TTL_MS = 60_000;

/** Canonical form so the SW's URL and the proxy's reconstructed URL compare equal. */
function canonicalUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

const USER_ENGINE_CONFIG = {
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  loadExtendedSelectors: true,
  enableCompression: false,
} as const;

/** Parse a user-rules text into a FiltersEngine; returns an empty engine on blank or error. */
export function parseUserRulesEngine(text: string): FiltersEngine {
  const trimmed = text.trim();
  if (!trimmed) return FiltersEngine.parse('', USER_ENGINE_CONFIG);
  try {
    return FiltersEngine.parse(trimmed, USER_ENGINE_CONFIG);
  } catch {
    return FiltersEngine.parse('', USER_ENGINE_CONFIG);
  }
}

interface CreateRuntimeContextOptions {
  baseEngine: FiltersEngine;
  /** Trackers-only engine; defaults to baseEngine when not provided (tests). */
  privacyEngine?: FiltersEngine;
  /** When the engines' lists were downloaded; defaults to now. */
  engineBuiltAt?: number;
  /** Downloads fresh lists; required for updateLists(). */
  rebuildEngines?: () => Promise<Engines>;
  /** App version string; defaults to 'dev'. */
  version?: string;
  /** Port the filtering proxy listens on; defaults to 8080. */
  proxyPort?: number;
  /** Set when the engines are empty stand-ins because the list download failed. */
  listsError?: string;
  /** Where the unpacked extension lives; defaults to <cwd>/extension. */
  extensionDir?: string;
  settings: Settings;
  stats: Stats;
}

/** Create a RuntimeContext from a loaded base engine and initial settings/stats. */
export function createRuntimeContext({
  baseEngine: initialBase,
  privacyEngine: initialPrivacy,
  engineBuiltAt,
  rebuildEngines,
  version = 'dev',
  proxyPort = 8080,
  listsError,
  extensionDir = `${process.cwd()}/extension`,
  settings: initialSettings,
  stats,
}: CreateRuntimeContextOptions): RuntimeContext {
  // Live settings - mutated in place
  const settings: Settings = { ...initialSettings };

  // Engines - swapped by updateLists()
  let baseEngine = initialBase;
  let privacyEngine = initialPrivacy ?? initialBase;
  let builtAt = engineBuiltAt ?? Date.now();
  let inflightUpdate: Promise<number> | null = null;

  // User engine - rebuilt on setUserRules
  let userEngine: FiltersEngine = parseUserRulesEngine('');
  let userRulesText = '';

  // Subscribers
  const listeners = new Set<(ev: ActivityEvent) => void>();
  const settingsListeners = new Set<(settings: Settings) => void>();

  function matchRequest(params: MatchParams): MatchResult {
    const req = Request.fromRawDetails(params as Parameters<typeof Request.fromRawDetails>[0]);
    // AdNauseam mode: ads must load (hidden) so they can be clicked, so only
    // the tracker lists decide what to block. User rules always apply.
    const engine = settings.adNauseam ? privacyEngine : baseEngine;
    const result = engine.match(req);
    if (result.match || result.redirect) return result;
    return userEngine.match(req);
  }

  // Pending AdNauseam clicks: url -> announcement + expiry
  const pendingClicks = new Map<string, PendingClick & { expires: number }>();

  function registerPendingClick(url: string, page: string, meta: { image?: string; title?: string } = {}): void {
    const now = Date.now();
    for (const [key, entry] of pendingClicks) {
      if (entry.expires < now) pendingClicks.delete(key);
    }
    pendingClicks.set(canonicalUrl(url), { page, ...meta, expires: now + PENDING_CLICK_TTL_MS });
  }

  function takePendingClick(url: string): PendingClick | undefined {
    const key = canonicalUrl(url);
    const entry = pendingClicks.get(key);
    if (!entry) return undefined;
    pendingClicks.delete(key);
    if (entry.expires < Date.now()) return undefined;
    const { expires: _expires, ...announced } = entry;
    return announced;
  }

  function getCosmetics(params: CosmeticsParams): CosmeticsResult {
    const opts = {
      url: params.url,
      hostname: params.hostname,
      domain: params.domain,
      classes: params.classes ?? [],
      ids: params.ids ?? [],
      hrefs: params.hrefs ?? [],
      getBaseRules: params.getBaseRules ?? true,
      getRulesFromHostname: params.getRulesFromHostname ?? true,
      getInjectionRules: params.getInjectionRules ?? true,
      getRulesFromDOM: true,
      getExtendedRules: true,
    };
    const base = baseEngine.getCosmeticsFilters(opts);
    const user = userEngine.getCosmeticsFilters(opts);

    // Concatenate styles (dedupe identical blocks)
    const stylesSet = new Set<string>();
    for (const s of [base.styles, user.styles]) {
      if (s && s.trim()) stylesSet.add(s.trim());
    }
    const styles = [...stylesSet].join('\n');

    // Merge scripts arrays
    const scripts = [...(base.scripts ?? []), ...(user.scripts ?? [])];

    // Merge extended rules, deduped by filter id
    const seen = new Set<number>();
    const extended: ExtendedRule[] = [];
    for (const rule of [...(base.extended ?? []), ...(user.extended ?? [])]) {
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      extended.push(rule);
    }

    return { styles, scripts, extended };
  }

  async function setUserRules(text: string): Promise<void> {
    userRulesText = text;
    userEngine = parseUserRulesEngine(text);
    await saveUserRules(text);
  }

  function getUserRules(): string {
    return userRulesText;
  }

  async function loadPersistedUserRules(): Promise<void> {
    const text = await loadUserRules();
    userRulesText = text;
    userEngine = parseUserRulesEngine(text);
  }

  async function updateSettings(patch: Partial<Settings>): Promise<void> {
    Object.assign(settings, patch);
    // Pass the full in-memory settings so saveSettings never needs to read
    // from disk (eliminates the read-merge-write race for concurrent callers).
    await saveSettings({ ...settings });
    for (const listener of settingsListeners) {
      try {
        listener(settings);
      } catch {
        // ignore listener errors
      }
    }
  }

  function recordEvent(ev: Omit<ActivityEvent, 'ts'>): void {
    stats.recordEvent(ev);
    const full: ActivityEvent = { ...ev, ts: Date.now() };
    for (const listener of listeners) {
      try {
        listener(full);
      } catch {
        // ignore listener errors
      }
    }
  }

  function subscribe(listener: (ev: ActivityEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function subscribeSettings(listener: (settings: Settings) => void): () => void {
    settingsListeners.add(listener);
    return () => settingsListeners.delete(listener);
  }

  function listsBuiltAt(): number {
    return builtAt;
  }

  const lists: ListsState = listsError ? { builtAt, error: listsError } : { builtAt };

  function updateLists(): Promise<number> {
    if (inflightUpdate) return inflightUpdate;
    if (!rebuildEngines) return Promise.reject(new Error('list updates are not available'));
    inflightUpdate = rebuildEngines()
      .then((engines) => {
        baseEngine = engines.base;
        privacyEngine = engines.privacy;
        builtAt = engines.builtAt;
        lists.builtAt = builtAt;
        delete lists.error;
        return builtAt;
      })
      .catch((err: unknown) => {
        lists.error = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        inflightUpdate = null;
      });
    return inflightUpdate;
  }

  const setup: SetupState = {
    caTrusted: null,
    trafficSeenAt: null,
    extensionSeenAt: settings.extensionSeenAt ?? null,
    extensionDir,
  };

  const updates: Updates = {
    status: { state: 'unavailable', message: 'not available in this mode' },
    setStatus(patch) {
      updates.status = { ...updates.status, message: undefined, ...patch };
    },
  };

  return {
    settings,
    stats,
    version,
    proxyPort,
    updates,
    lists,
    setup,
    matchRequest,
    getCosmetics,
    setUserRules,
    getUserRules,
    loadPersistedUserRules,
    updateSettings,
    recordEvent,
    subscribe,
    subscribeSettings,
    listsBuiltAt,
    updateLists,
    registerPendingClick,
    takePendingClick,
  };
}
