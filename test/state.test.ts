import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  ACTIVITY_RING_SIZE,
  BROKEN_REPORTS_CAP,
  SITE_STATS_CAP,
  createStats,
  loadSettings,
  loadStats,
  loadUserRules,
  saveSettings,
  saveStats,
  saveUserRules,
} from '../src/state.js';

// Tests run against a temp dir - never touch ~/.ghetto-blocker.
// paths.ts reads GHETTO_DATA_DIR at call-time so static imports work fine.
let testDataDir: string;

beforeEach(async () => {
  testDataDir = await mkdtemp(join(tmpdir(), 'ghetto-state-test-'));
  process.env['GHETTO_DATA_DIR'] = testDataDir;
});

afterEach(async () => {
  delete process.env['GHETTO_DATA_DIR'];
  await rm(testDataDir, { recursive: true, force: true });
});

describe('loadSettings', () => {
  it('maps a retired theme name to cyberpunk', async () => {
    await writeFile(join(testDataDir, 'settings.json'), JSON.stringify({ theme: 'synthwave' }));
    expect((await loadSettings()).theme).toBe('cyberpunk');
    await writeFile(join(testDataDir, 'settings.json'), JSON.stringify({ theme: 'daylight' }));
    expect((await loadSettings()).theme).toBe('daylight');
  });

  it('returns defaults when no file exists', async () => {
    const s = await loadSettings();
    expect(s.paused).toBe(false);
    expect(s.injectCosmetics).toBe(true);
    expect(s.stripCSP).toBe(true);
    expect(s.antiAnalytics).toBe(true);
    expect(s.theme).toBe('daylight');
    expect(s.controlPort).toBe(8081);
    expect(s.autostart).toBe(false);
    expect(Array.isArray(s.allowlist)).toBe(true);
    expect(Array.isArray(s.bypassHosts)).toBe(true);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a full Settings object', async () => {
    const toSave: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS, paused: true, theme: 'daylight' };
    await saveSettings(toSave);
    const s = await loadSettings();
    expect(s.paused).toBe(true);
    expect(s.theme).toBe('daylight');
    expect(s.injectCosmetics).toBe(true); // un-patched fields survive in the caller-merged object
  });

  it('overwrites existing file with the provided settings object', async () => {
    // First write: bypassHosts populated
    await saveSettings({ ...DEFAULT_SETTINGS, bypassHosts: ['example.com'] });
    // Second write: caller merges manually before saving
    const prev = await loadSettings();
    await saveSettings({ ...prev, paused: true });
    const s = await loadSettings();
    expect(s.bypassHosts).toEqual(['example.com']);
    expect(s.paused).toBe(true);
  });
});

describe('loadUserRules / saveUserRules', () => {
  it('returns empty string when no file exists', async () => {
    expect(await loadUserRules()).toBe('');
  });

  it('round-trips after saveUserRules', async () => {
    const rules = '||ads.example.com^\nexample.com##.ad-banner\n';
    await saveUserRules(rules);
    expect(await loadUserRules()).toBe(rules);
  });
});

describe('Stats -- bounded collections', () => {
  it('per-site map caps at SITE_STATS_CAP and evicts minimum-count entry', () => {
    const stats = createStats();

    for (let i = 0; i < SITE_STATS_CAP; i++) {
      stats.recordSiteBlock(`host${i}.example`);
    }
    expect(Object.keys(stats.sites).length).toBe(SITE_STATS_CAP);

    // One more should evict an entry (the one with the lowest block count)
    stats.recordSiteBlock('newhost.example');
    expect(Object.keys(stats.sites).length).toBe(SITE_STATS_CAP);
    expect('newhost.example' in stats.sites).toBe(true);
  });

  it('activity ring buffer stays bounded', () => {
    const stats = createStats();
    for (let i = 0; i < ACTIVITY_RING_SIZE + 10; i++) {
      stats.recordEvent({ type: 'block', host: 'a.com', url: 'https://a.com/x', rule: undefined });
    }
    expect(stats.getRecentActivity().length).toBeLessThanOrEqual(ACTIVITY_RING_SIZE);
  });

  it('broken reports ring stays bounded', () => {
    const stats = createStats();
    for (let i = 0; i < BROKEN_REPORTS_CAP + 5; i++) {
      stats.addBrokenReport({ host: `host${i}.com`, comment: 'broken', ts: Date.now() });
    }
    expect(stats.getBrokenReports().length).toBeLessThanOrEqual(BROKEN_REPORTS_CAP);
  });
});

describe('saveStats / loadStats', () => {
  it('persists the AdNauseam vault (newest first on read) and caps it', async () => {
    const stats = createStats();
    for (let i = 0; i < 205; i++) {
      stats.recordClick({ url: `https://ad.example/${i}`, host: 'ad.example', page: 'p', ts: i, image: `https://cdn.example/${i}.png`, title: `ad ${i}` });
    }
    expect(stats.getVault()).toHaveLength(200);
    expect(stats.getVault()[0]?.url).toBe('https://ad.example/204');
    await saveStats(stats);
    const loaded = await loadStats();
    expect(loaded.getVault()).toHaveLength(200);
    expect(loaded.getVault()[0]).toMatchObject({ url: 'https://ad.example/204', image: 'https://cdn.example/204.png', title: 'ad 204' });
  });

  it('keeps the "since" timestamp so totals read as all-time after a restart', async () => {
    const stats = createStats({ since: 1_700_000_000_000 });
    stats.totals.blocked = 7;
    await saveStats(stats);
    const loaded = await loadStats();
    expect(loaded.since).toBe(1_700_000_000_000);
    expect(loaded.totals.blocked).toBe(7);
    expect(createStats().since).toBeGreaterThan(1_700_000_000_000);
  });

  it('flushes stats and reloads them', async () => {
    const stats = createStats();
    stats.recordSiteBlock('test.com');
    stats.totals.blocked += 5;
    await saveStats(stats);
    const loaded = await loadStats();
    expect(loaded.totals.blocked).toBe(5);
    expect('test.com' in loaded.sites).toBe(true);
  });
});
