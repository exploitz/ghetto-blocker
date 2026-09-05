import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FiltersEngine } from '@ghostery/adblocker';
import { createRuntimeContext } from '../src/runtime.js';
import { createStats } from '../src/state.js';
import type { Settings } from '../src/state.js';

// Minimal base engine with one network rule and one cosmetic rule
const BASE_RULES = [
  '||base-blocked.example^',
  'base.example##.base-ad',
].join('\n');

const baseEngine = FiltersEngine.parse(BASE_RULES, {
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  enableCompression: false,
});

const defaultSettings: Settings = {
  paused: false,
  injectCosmetics: true,
  stripCSP: true,
  antiAnalytics: true,
  theme: 'terminal',
  controlPort: 8081,
  autostart: false,
  adNauseam: false,
  allowlist: [],
  bypassHosts: [],
};

let testDataDir: string;

beforeEach(async () => {
  testDataDir = await mkdtemp(join(tmpdir(), 'ghetto-runtime-test-'));
  process.env['GHETTO_DATA_DIR'] = testDataDir;
});

afterEach(async () => {
  delete process.env['GHETTO_DATA_DIR'];
  await rm(testDataDir, { recursive: true, force: true });
});

function makeCtx(settingsPatch?: Partial<Settings>) {
  return createRuntimeContext({
    baseEngine,
    settings: { ...defaultSettings, ...settingsPatch },
    stats: createStats(),
  });
}

describe('matchRequest', () => {
  it('blocks a URL matched by the base engine', () => {
    const ctx = makeCtx();
    const result = ctx.matchRequest({
      type: 'script',
      url: 'https://base-blocked.example/a.js',
      sourceUrl: 'https://example.com',
    });
    expect(result.match).toBe(true);
  });

  it('blocks a URL matched only in user rules without rebuilding base engine', async () => {
    const ctx = makeCtx();
    await ctx.setUserRules('||user-blocked.example^');
    const result = ctx.matchRequest({
      type: 'script',
      url: 'https://user-blocked.example/a.js',
      sourceUrl: 'https://example.com',
    });
    expect(result.match).toBe(true);
  });

  it('passes through an unmatched URL', () => {
    const ctx = makeCtx();
    const result = ctx.matchRequest({
      type: 'script',
      url: 'https://allowed.example/app.js',
      sourceUrl: 'https://example.com',
    });
    expect(result.match).toBe(false);
  });
});

describe('getCosmetics', () => {
  it('returns base-engine cosmetic rules', () => {
    const ctx = makeCtx();
    const c = ctx.getCosmetics({
      url: 'https://base.example/',
      hostname: 'base.example',
      domain: 'base.example',
    });
    expect(c.styles).toContain('.base-ad');
  });

  it('returns user cosmetic rules (hostname##selector) without rebuilding base engine', async () => {
    const ctx = makeCtx();
    await ctx.setUserRules('user.example##.user-ad');
    const c = ctx.getCosmetics({
      url: 'https://user.example/',
      hostname: 'user.example',
      domain: 'user.example',
    });
    expect(c.styles).toContain('.user-ad');
  });

  it('merges base and user cosmetic rules for the same hostname', async () => {
    const ctx = makeCtx();
    await ctx.setUserRules('base.example##.user-injected');
    const c = ctx.getCosmetics({
      url: 'https://base.example/',
      hostname: 'base.example',
      domain: 'base.example',
    });
    expect(c.styles).toContain('.base-ad');
    expect(c.styles).toContain('.user-injected');
  });
});

describe('setUserRules', () => {
  it('malformed rules text does not throw and yields engine matching nothing', async () => {
    const ctx = makeCtx();
    await expect(ctx.setUserRules('@@@@@@invalid@@@@')).resolves.not.toThrow();
    const result = ctx.matchRequest({
      type: 'script',
      url: 'https://user-blocked.example/a.js',
      sourceUrl: 'https://example.com',
    });
    expect(result.match).toBe(false);
  });

  it('persists rules to disk so a new context reads them back', async () => {
    const ctx = makeCtx();
    await ctx.setUserRules('||persisted.example^');
    // A fresh context loading from disk should also block the same URL
    const ctx2 = makeCtx();
    await ctx2.loadPersistedUserRules();
    const result = ctx2.matchRequest({
      type: 'script',
      url: 'https://persisted.example/a.js',
      sourceUrl: 'https://example.com',
    });
    expect(result.match).toBe(true);
  });
});

describe('updateSettings', () => {
  it('mutates live settings and persists them', async () => {
    const ctx = makeCtx();
    expect(ctx.settings.paused).toBe(false);
    await ctx.updateSettings({ paused: true });
    expect(ctx.settings.paused).toBe(true);
  });
});

describe('recordEvent', () => {
  it('pushes an event into the stats activity ring', () => {
    const ctx = makeCtx();
    ctx.recordEvent({ type: 'block', host: 'ads.example', url: 'https://ads.example/x', rule: undefined });
    expect(ctx.stats.getRecentActivity().length).toBe(1);
    expect(ctx.stats.getRecentActivity()[0]!.host).toBe('ads.example');
  });
});

describe('getCosmetics with DOM features', () => {
  const engine = FiltersEngine.parse(
    [
      '##.generic-ad-box',
      '###generic-ad-id',
      '##[id^="ad-generic-"]',
      'ext.example##div:has-text(Sponsored)',
    ].join('\n'),
    {
      loadNetworkFilters: true,
      loadCosmeticFilters: true,
      loadExtendedSelectors: true,
      enableCompression: false,
    },
  );
  const page = { url: 'https://any.example/', hostname: 'any.example', domain: 'any.example' };
  const domCtx = () =>
    createRuntimeContext({ baseEngine: engine, settings: { ...defaultSettings }, stats: createStats() });

  it('returns class/id-indexed generic rules only when the page contains those features', () => {
    const ctx = domCtx();
    const without = ctx.getCosmetics(page);
    expect(without.styles).not.toContain('.generic-ad-box');
    expect(without.styles).not.toContain('#generic-ad-id');

    const withFeatures = ctx.getCosmetics({
      ...page,
      classes: ['generic-ad-box'],
      ids: ['generic-ad-id'],
    });
    expect(withFeatures.styles).toContain('.generic-ad-box');
    expect(withFeatures.styles).toContain('#generic-ad-id');
  });

  it('includes the base (non-indexed) generic rules by default and omits them on request', () => {
    const ctx = domCtx();
    expect(ctx.getCosmetics(page).styles).toContain('[id^="ad-generic-"]');
    expect(ctx.getCosmetics({ ...page, getBaseRules: false }).styles).not.toContain('[id^="ad-generic-"]');
  });

  it('returns procedural rules for the hostname together with their attribute stylesheet', () => {
    const ctx = domCtx();
    const r = ctx.getCosmetics({ url: 'https://ext.example/', hostname: 'ext.example', domain: 'ext.example' });
    expect(r.extended).toHaveLength(1);
    const attribute = r.extended[0]?.attribute;
    expect(attribute).toBeTruthy();
    expect(r.styles).toContain(`[${attribute}]`);
    expect(ctx.getCosmetics({ url: 'https://ext.example/', hostname: 'ext.example', domain: 'ext.example', getRulesFromHostname: false }).extended).toHaveLength(0);
  });

  it('merges DOM-indexed rules from the user engine', async () => {
    const ctx = domCtx();
    await ctx.setUserRules('##.user-generic-ad');
    expect(ctx.getCosmetics({ ...page, classes: ['user-generic-ad'] }).styles).toContain('.user-generic-ad');
  });
});

describe('subscribeSettings', () => {
  it('notifies listeners after updateSettings and stops after unsubscribe', async () => {
    const ctx = makeCtx();
    const seen: boolean[] = [];
    const unsubscribe = ctx.subscribeSettings((s) => seen.push(s.paused));
    await ctx.updateSettings({ paused: true });
    expect(seen).toEqual([true]);
    unsubscribe();
    await ctx.updateSettings({ paused: false });
    expect(seen).toEqual([true]);
  });
});

describe('updateLists', () => {
  const parse = (rules: string) =>
    FiltersEngine.parse(rules, { loadNetworkFilters: true, loadCosmeticFilters: true, enableCompression: false });
  const req = (host: string) => ({ type: 'script', url: `https://${host}/a.js`, sourceUrl: 'https://page.example' });

  it('swaps in freshly built engines and reports the new build time', async () => {
    let builds = 0;
    const ctx = createRuntimeContext({
      baseEngine: parse('||old-ad.example^'),
      engineBuiltAt: 1000,
      rebuildEngines: async () => {
        builds++;
        return { base: parse('||new-ad.example^'), privacy: parse(''), builtAt: 2000 };
      },
      settings: { ...defaultSettings },
      stats: createStats(),
    });
    expect(ctx.matchRequest(req('old-ad.example')).match).toBe(true);
    expect(ctx.listsBuiltAt()).toBe(1000);

    const [a, b] = await Promise.all([ctx.updateLists(), ctx.updateLists()]);
    expect(a).toBe(2000);
    expect(b).toBe(2000);
    expect(builds).toBe(1); // concurrent calls share one download
    expect(ctx.listsBuiltAt()).toBe(2000);
    expect(ctx.matchRequest(req('new-ad.example')).match).toBe(true);
    expect(ctx.matchRequest(req('old-ad.example')).match).toBe(false);
  });

  it('rejects when no rebuild function was provided', async () => {
    await expect(makeCtx().updateLists()).rejects.toThrow(/not available/);
  });
});

describe('AdNauseam mode', () => {
  const parse = (rules: string) =>
    FiltersEngine.parse(rules, { loadNetworkFilters: true, loadCosmeticFilters: true, enableCompression: false });
  const req = (host: string) => ({ type: 'script', url: `https://${host}/a.js`, sourceUrl: 'https://page.example' });
  const adCtx = (adNauseam: boolean) =>
    createRuntimeContext({
      baseEngine: parse('||ad.example^\n||tracker.example^'),
      privacyEngine: parse('||tracker.example^'),
      settings: { ...defaultSettings, adNauseam },
      stats: createStats(),
    });

  it('lets ads through but keeps blocking trackers while on', () => {
    const ctx = adCtx(true);
    expect(ctx.matchRequest(req('ad.example')).match).toBe(false);
    expect(ctx.matchRequest(req('tracker.example')).match).toBe(true);
  });

  it('blocks ads again when off', () => {
    expect(adCtx(false).matchRequest(req('ad.example')).match).toBe(true);
  });

  it('still enforces user rules while on', async () => {
    const ctx = adCtx(true);
    await ctx.setUserRules('||ad.example^');
    expect(ctx.matchRequest(req('ad.example')).match).toBe(true);
  });

  it('hands a pending click to the proxy exactly once, with URL normalisation', () => {
    const ctx = adCtx(true);
    ctx.registerPendingClick('https://adclick.example/aclk?id=1&gclid=x', 'https://news.example/');
    expect(ctx.takePendingClick('https://ADCLICK.example/aclk?id=1&gclid=x')).toEqual({ page: 'https://news.example/' });
    expect(ctx.takePendingClick('https://adclick.example/aclk?id=1&gclid=x')).toBeUndefined();
    expect(ctx.takePendingClick('https://adclick.example/other')).toBeUndefined();
  });
});
