import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { settingsPath, statsPath, userRulesPath } from './paths.js';

// ---------------------------------------------------------------------------
// Bounded-collection limits (exported so tests can assert against them)
// ---------------------------------------------------------------------------

/** Max entries in the per-site stat map. Evicts the min-count entry when hit. */
export const SITE_STATS_CAP = 500;

/** Fixed size of the recent-activity ring buffer. */
export const ACTIVITY_RING_SIZE = 200;

/** Max number of broken-site reports retained. */
export const BROKEN_REPORTS_CAP = 50;

/** Max number of clicked ads kept in the AdNauseam vault. */
export const VAULT_CAP = 200;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Runtime-mutable settings (persisted to settings.json). */
export interface Settings {
  /** Pause all filtering without stopping the proxy. */
  paused: boolean;
  /** Inject element-hiding CSS into HTML responses. */
  injectCosmetics: boolean;
  /** Strip CSP on HTML so injected CSS/JS can run. */
  stripCSP: boolean;
  /** Strip tracking params (utm_*, gclid, fbclid, ...) from GET navigations. */
  antiAnalytics: boolean;
  /** Dashboard colour theme. */
  theme: 'terminal' | 'cyberpunk' | 'daylight';
  /** Port the local control server listens on. */
  controlPort: number;
  /** Open the app at Windows logon (Electron only). */
  autostart: boolean;
  /**
   * AdNauseam mode: let ad requests load (hidden) instead of blocking them,
   * keep blocking trackers, and have the extension click the hidden ads in
   * the background to poison the ad networks' profiles.
   */
  adNauseam: boolean;
  /** Hosts the user has allowlisted via "I allow this site" (no filtering). */
  allowlist: string[];
  /**
   * Hosts passed through completely unfiltered (cert-pinned apps, banking).
   * Matched by exact host or subdomain suffix.
   */
  bypassHosts: string[];
  /** When the companion extension last talked to the control server (setup checklist). */
  extensionSeenAt?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  injectCosmetics: true,
  stripCSP: true,
  antiAnalytics: true,
  theme: 'daylight',
  controlPort: 8081,
  autostart: false,
  adNauseam: false,
  allowlist: [],
  // MITM-incompatible by default: cert-pinned or streaming apps that misbehave
  // when their TLS is terminated. Bypass hosts are tunneled raw (no
  // interception), so these connect exactly as they would with no proxy.
  bypassHosts: ['chatgpt.com'],
};

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

/** Write a file atomically: write temp then rename to avoid partial writes. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = filePath + '.tmp';
  await ensureDir(filePath);
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, filePath);
}

/** Load settings from disk; returns defaults if the file does not exist. */
export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(settingsPath(), 'utf8');
    const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings;
    // Retired themes ("glass", "synthwave") map to the closest survivor.
    if (!['terminal', 'cyberpunk', 'daylight'].includes(settings.theme as string)) {
      settings.theme = 'cyberpunk';
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist a complete Settings object to disk.
 * The caller is responsible for merging any patch with the in-memory
 * settings before calling this function -- no disk read is performed here,
 * which eliminates the read-merge-write race when callers run concurrently.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  await atomicWrite(settingsPath(), JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// User rules
// ---------------------------------------------------------------------------

/** Load the user-rules text file; returns '' when it does not exist. */
export async function loadUserRules(): Promise<string> {
  try {
    return await readFile(userRulesPath(), 'utf8');
  } catch {
    return '';
  }
}

/** Persist the full user-rules text (uBO-syntax, one rule per line). */
export async function saveUserRules(text: string): Promise<void> {
  await atomicWrite(userRulesPath(), text);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface SiteStat {
  blocked: number;
  hidden: number;
  poisoned: number;
}

export interface ActivityEvent {
  type: 'block' | 'hide' | 'poison' | 'allow' | 'click';
  host: string;
  url: string;
  rule: string | undefined;
  ts: number;
}

export interface BrokenReport {
  host: string;
  comment: string;
  ts: number;
}

export interface StatTotals {
  blocked: number;
  redirected: number;
  injected: number;
  allowed: number;
  poisoned: number;
  /** Ads clicked by AdNauseam mode. */
  clicked: number;
}

/** One ad clicked by AdNauseam mode. */
export interface VaultEntry {
  /** Ad click-through URL that was fetched. */
  url: string;
  /** Ad network host the click went to. */
  host: string;
  /** Page the ad was found on. */
  page: string;
  ts: number;
  /** Creative image URL, when the ad had one. */
  image?: string;
  /** Ad copy: alt text, title or link text. */
  title?: string;
}

export interface Stats {
  totals: StatTotals;
  /** When counting started (epoch ms); survives restarts with the totals. */
  since: number;
  /** Per-site stat map; bounded at SITE_STATS_CAP. */
  sites: Record<string, SiteStat>;
  /** Increment the blocked counter for a host, evicting min-count entry if at cap. */
  recordSiteBlock(host: string): void;
  /** Increment the hidden counter for a host. */
  recordSiteHide(host: string): void;
  /** Increment the poisoned counter for a host. */
  recordSitePoisoned(host: string): void;
  /** Push an event to the fixed-size activity ring. */
  recordEvent(ev: Omit<ActivityEvent, 'ts'>): void;
  /** Return recent activity events, newest first, up to ACTIVITY_RING_SIZE. */
  getRecentActivity(): ActivityEvent[];
  /** Append a broken-site report; oldest evicted when at cap. */
  addBrokenReport(r: BrokenReport): void;
  /** Return all retained broken reports. */
  getBrokenReports(): BrokenReport[];
  /** Record a clicked ad; oldest evicted when at VAULT_CAP. */
  recordClick(entry: VaultEntry): void;
  /** Clicked ads, newest first. */
  getVault(): VaultEntry[];
  /** Forget the clicked ads (the running total is kept). */
  clearVault(): void;
}

function ensureSite(stats: Pick<Stats, 'sites'>, host: string): void {
  if (!(host in stats.sites)) {
    const entries = Object.entries(stats.sites);
    if (entries.length >= SITE_STATS_CAP) {
      // Evict the entry with the smallest total count
      let minKey = entries[0]![0];
      let minTotal = entries[0]![1].blocked + entries[0]![1].hidden + entries[0]![1].poisoned;
      for (let i = 1; i < entries.length; i++) {
        const e = entries[i]!;
        const total = e[1].blocked + e[1].hidden + e[1].poisoned;
        if (total < minTotal) {
          minTotal = total;
          minKey = e[0];
        }
      }
      delete stats.sites[minKey];
    }
    stats.sites[host] = { blocked: 0, hidden: 0, poisoned: 0 };
  }
}

/** Create a fresh in-memory Stats object. */
export function createStats(
  initial?: Partial<Pick<Stats, 'totals' | 'sites' | 'since'>> & { vault?: VaultEntry[] },
): Stats {
  const totals: StatTotals = {
    blocked: 0, redirected: 0, injected: 0, allowed: 0, poisoned: 0, clicked: 0,
    ...(initial?.totals ?? {}),
  };
  const sites: Record<string, SiteStat> = { ...(initial?.sites ?? {}) };
  const since = initial?.since ?? Date.now();
  const vault: VaultEntry[] = [...(initial?.vault ?? [])].slice(-VAULT_CAP);

  // Ring buffer for activity events
  const ring: ActivityEvent[] = [];
  let ringHead = 0; // next write position

  // Ring buffer for broken reports
  const reports: BrokenReport[] = [];

  function recordSiteBlock(host: string): void {
    ensureSite({ sites }, host);
    sites[host]!.blocked++;
  }

  function recordSiteHide(host: string): void {
    ensureSite({ sites }, host);
    sites[host]!.hidden++;
  }

  function recordSitePoisoned(host: string): void {
    ensureSite({ sites }, host);
    sites[host]!.poisoned++;
  }

  function recordEvent(ev: Omit<ActivityEvent, 'ts'>): void {
    const entry: ActivityEvent = { ...ev, ts: Date.now() };
    if (ring.length < ACTIVITY_RING_SIZE) {
      ring.push(entry);
    } else {
      ring[ringHead] = entry;
      ringHead = (ringHead + 1) % ACTIVITY_RING_SIZE;
    }
  }

  function getRecentActivity(): ActivityEvent[] {
    if (ring.length < ACTIVITY_RING_SIZE) {
      return [...ring].reverse();
    }
    // Ring is full: reconstruct in order oldest->newest then reverse
    const ordered: ActivityEvent[] = [];
    for (let i = 0; i < ACTIVITY_RING_SIZE; i++) {
      ordered.push(ring[(ringHead + i) % ACTIVITY_RING_SIZE]!);
    }
    return ordered.reverse();
  }

  function addBrokenReport(r: BrokenReport): void {
    if (reports.length >= BROKEN_REPORTS_CAP) {
      reports.shift(); // drop oldest
    }
    reports.push(r);
  }

  function getBrokenReports(): BrokenReport[] {
    return [...reports];
  }

  function recordClick(entry: VaultEntry): void {
    if (vault.length >= VAULT_CAP) vault.shift();
    vault.push(entry);
  }

  function getVault(): VaultEntry[] {
    return [...vault].reverse();
  }

  function clearVault(): void {
    vault.length = 0;
  }

  return {
    totals,
    since,
    sites,
    recordSiteBlock,
    recordSiteHide,
    recordSitePoisoned,
    recordEvent,
    getRecentActivity,
    addBrokenReport,
    getBrokenReports,
    recordClick,
    getVault,
    clearVault,
  };
}

// ---------------------------------------------------------------------------
// Stats persistence
// ---------------------------------------------------------------------------

interface PersistedStats {
  totals: StatTotals;
  sites: Record<string, SiteStat>;
  since?: number;
  vault?: VaultEntry[];
}

/** Persist stats to disk (call on interval + shutdown). */
export async function saveStats(stats: Stats): Promise<void> {
  const payload: PersistedStats = {
    totals: stats.totals,
    sites: stats.sites,
    since: stats.since,
    vault: stats.getVault().reverse(), // stored oldest first
  };
  await atomicWrite(statsPath(), JSON.stringify(payload));
}

/** Load stats from disk; returns a fresh Stats object if file is missing. */
export async function loadStats(): Promise<Stats> {
  try {
    const raw = await readFile(statsPath(), 'utf8');
    const { totals, sites, since, vault } = JSON.parse(raw) as PersistedStats;
    return createStats({ totals, sites, since, vault });
  } catch {
    return createStats();
  }
}
