import type { Settings, StatTotals, SiteStat, ActivityEvent, BrokenReport, VaultEntry } from './state.js';
import type { ExtendedRule, UpdateStatus } from './runtime.js';

/** Response body for GET /api/state. */
export interface StateResponse {
  settings: Settings;
  /** All-time totals (persisted across restarts). */
  totals: StatTotals;
  /** When the totals started counting (epoch ms). */
  since: number;
  /** Filter-list freshness. */
  lists: { builtAt: number };
  /** Running app version. */
  version: string;
  /** Self-update status (desktop app). */
  update: UpdateStatus;
}

/** Response body for GET /api/stats (full detail). */
export interface StatsResponse {
  totals: StatTotals;
  sites: Record<string, SiteStat>;
  recentActivity: ActivityEvent[];
  brokenReports: BrokenReport[];
}

/** Response body for GET /api/rules. */
export interface RulesGetResponse {
  text: string;
}

/** Response body for GET /api/allowlist. */
export interface AllowlistResponse {
  allowlist: string[];
}

/** Response body for GET /api/bypass. */
export interface BypassResponse {
  bypassHosts: string[];
}

/** Response body for POST /api/import (success). */
export interface ImportResult {
  count: number;
}

/**
 * Shape of the JSON file exported by GET /api/export
 * and consumed by POST /api/import.
 */
export interface ExportBackup {
  version: 1;
  settings: Settings;
  userRules: string;
  exportedAt: number;
}

/**
 * Request body for POST /api/cosmetics. Sent by the extension's service worker
 * on behalf of the content script running in a page.
 */
export interface CosmeticsRequest {
  /** Full page URL (frame URL for sub-frames). */
  url: string;
  /** `start` = first call for a document (hostname rules included); `dom-update` = new features only. */
  lifecycle?: 'start' | 'dom-update';
  classes?: string[];
  ids?: string[];
  hrefs?: string[];
}

/** Response body for POST /api/cosmetics. */
export interface CosmeticsResponse {
  /** False when filtering is paused/disabled or the host is allowlisted/bypassed. */
  active: boolean;
  /** True when the content script should hunt for hidden ads' click links. */
  adNauseam?: boolean;
  /** CSS to apply to the frame (empty when nothing matched). */
  styles: string;
  /** Procedural rules the content script evaluates against the DOM. */
  extended: ExtendedRule[];
}

/** Request body for POST /api/adnauseam/click: the extension is about to fetch this ad link. */
export interface ClickRequest {
  url: string;
  /** Page (URL or host) the ad was found on. */
  page: string;
  /** Creative image URL, when the ad had one. */
  image?: string;
  /** Ad copy: alt text, title or link text. */
  title?: string;
}

/** Response body for GET /api/adnauseam/vault. */
export interface VaultResponse {
  clicked: number;
  entries: VaultEntry[];
}

/** Response body for GET /api/browsers. */
export interface BrowsersResponse {
  browsers: { id: string; name: string; running: 'not-running' | 'proxied' | 'unproxied' | 'unknown' }[];
  /** The flags a browser must be started with (shown in the UI as a fallback). */
  flags: string[];
}
