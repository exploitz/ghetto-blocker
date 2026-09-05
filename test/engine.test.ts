import { describe, it, expect } from 'vitest';
import { FiltersEngine, Request } from '@ghostery/adblocker';

// Build an engine from a tiny inline list - no network, fully deterministic.
const engine = FiltersEngine.parse(
  ['||ads.example.com^', '/tracker.js', 'example.com##.ad-banner'].join('\n'),
  { loadNetworkFilters: true, loadCosmeticFilters: true, enableCompression: false },
);

describe('network matching', () => {
  it('blocks a known ad host', () => {
    const r = engine.match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://ads.example.com/a.js',
        sourceUrl: 'https://example.com',
      }),
    );
    expect(r.match).toBe(true);
  });

  it('blocks by path rule on any host', () => {
    const r = engine.match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://cdn.foo.com/tracker.js',
        sourceUrl: 'https://example.com',
      }),
    );
    expect(r.match).toBe(true);
  });

  it('allows an unrelated request', () => {
    const r = engine.match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://example.com/app.js',
        sourceUrl: 'https://example.com',
      }),
    );
    expect(r.match).toBe(false);
  });
});

describe('cosmetic filters', () => {
  it('returns hostname-specific hiding CSS', () => {
    const c = engine.getCosmeticsFilters({
      url: 'https://example.com/',
      hostname: 'example.com',
      domain: 'example.com',
      getBaseRules: false,
      getRulesFromHostname: true,
    });
    expect(c.styles).toContain('.ad-banner');
  });
});
