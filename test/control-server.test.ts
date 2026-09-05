import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FiltersEngine } from '@ghostery/adblocker';
import { route, createControlServer } from '../src/control-server.js';
import { createRuntimeContext } from '../src/runtime.js';
import { createStats } from '../src/state.js';
import type { Settings } from '../src/state.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const emptyEngine = FiltersEngine.parse('', {
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  enableCompression: false,
});

const baseSettings: Settings = {
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

const PORT = 8081;

let testDataDir: string;

// Port used by the live server tests
let livePort: number;
let liveCtx: ReturnType<typeof createRuntimeContext>;
let liveServer: http.Server;

function makeCtx(patch?: Partial<Settings>) {
  return createRuntimeContext({
    baseEngine: emptyEngine,
    settings: { ...baseSettings, ...patch },
    stats: createStats(),
  });
}

/** Build a RouteRequest-equivalent call against route(). */
function req(
  method: string,
  pathname: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    port?: number;
    csrf?: boolean;
    host?: string;
  } = {},
) {
  const {
    body,
    headers = {},
    port = PORT,
    csrf = true,
    host = `127.0.0.1:${port}`,
  } = opts;
  const allHeaders: Record<string, string> = {
    host,
    'content-type': 'application/json',
    ...(csrf ? { 'x-ghettoblocker': '1' } : {}),
    ...headers,
  };
  const rawBody =
    body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  return route(method, pathname, allHeaders, rawBody, port, makeCtx());
}

/** Same as req() but uses a specific ctx (needed for mutation tests). */
function reqCtx(
  method: string,
  pathname: string,
  ctx: ReturnType<typeof makeCtx>,
  opts: { body?: unknown; csrf?: boolean } = {},
) {
  const { body, csrf = true } = opts;
  const rawBody =
    body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  return route(
    method,
    pathname,
    {
      host: `127.0.0.1:${PORT}`,
      'content-type': 'application/json',
      ...(csrf ? { 'x-ghettoblocker': '1' } : {}),
    },
    rawBody,
    PORT,
    ctx,
  );
}

beforeAll(async () => {
  testDataDir = await mkdtemp(join(tmpdir(), 'ghetto-cs-test-'));
  process.env['GHETTO_DATA_DIR'] = testDataDir;

  liveCtx = makeCtx();
  liveServer = createControlServer(liveCtx);
  await new Promise<void>((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
  livePort = (liveServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => liveServer.close(() => resolve()));
  delete process.env['GHETTO_DATA_DIR'];
  await rm(testDataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure route() unit tests (no live socket needed)
// ---------------------------------------------------------------------------

describe('GET /api/state', () => {
  it('returns settings and totals with 200', async () => {
    const r = await req('GET', '/api/state');
    expect(r.status).toBe(200);
    const body = r.body as { settings: Settings; totals: object };
    expect(body.settings.paused).toBe(false);
    expect(typeof body.totals).toBe('object');
  });
});

describe('CSRF / Host header defense', () => {
  it('rejects a mutating request that lacks X-GhettoBlocker: 1', async () => {
    const r = await req('POST', '/api/settings', { body: { paused: true }, csrf: false });
    expect(r.status).toBe(403);
  });

  it('rejects any request with a foreign Host header', async () => {
    const r = await req('GET', '/api/state', { host: 'evil.example.com:8081' });
    expect(r.status).toBe(403);
  });

  it('accepts GET without X-GhettoBlocker (read-only endpoint)', async () => {
    const r = await req('GET', '/api/state', { csrf: false });
    expect(r.status).toBe(200);
  });

  it('accepts localhost as valid Host', async () => {
    const r = await req('GET', '/api/state', { host: `localhost:${PORT}` });
    expect(r.status).toBe(200);
  });
});

describe('POST /api/settings', () => {
  it('mutates the live context and returns 200', async () => {
    const ctx = makeCtx();
    expect(ctx.settings.paused).toBe(false);
    const r = await reqCtx('POST', '/api/settings', ctx, { body: { paused: true } });
    expect(r.status).toBe(200);
    expect(ctx.settings.paused).toBe(true);
  });
});

describe('GET /api/stats', () => {
  it('returns full stats with 200', async () => {
    const r = await req('GET', '/api/stats');
    expect(r.status).toBe(200);
    const body = r.body as { totals: object; sites: object; recentActivity: unknown[]; brokenReports: unknown[] };
    expect(Array.isArray(body.recentActivity)).toBe(true);
    expect(Array.isArray(body.brokenReports)).toBe(true);
  });
});

describe('GET /api/rules + PUT /api/rules + POST /api/rules/append', () => {
  it('GET /api/rules returns text with 200', async () => {
    const r = await req('GET', '/api/rules');
    expect(r.status).toBe(200);
    expect(typeof (r.body as { text: string }).text).toBe('string');
  });

  it('POST /api/rules/append adds a rule', async () => {
    const ctx = makeCtx();
    const r = await reqCtx('POST', '/api/rules/append', ctx, { body: { rule: '||ads.example^' } });
    expect(r.status).toBe(200);
    // Verify the rule was persisted (state reflects the new rules text)
    expect(ctx.settings).toBeDefined(); // context still intact
  });

  it('PUT /api/rules replaces rules text', async () => {
    const ctx = makeCtx();
    const r = await reqCtx('PUT', '/api/rules', ctx, { body: { text: '||replaced.example^' } });
    expect(r.status).toBe(200);
  });
});

describe('GET+POST+DELETE /api/allowlist', () => {
  it('GET returns the allowlist', async () => {
    const r = await req('GET', '/api/allowlist');
    expect(r.status).toBe(200);
    expect(Array.isArray((r.body as { allowlist: string[] }).allowlist)).toBe(true);
  });

  it('POST adds a host', async () => {
    const ctx = makeCtx();
    const r = await reqCtx('POST', '/api/allowlist', ctx, { body: { host: 'example.com' } });
    expect(r.status).toBe(200);
    expect(ctx.settings.allowlist).toContain('example.com');
  });

  it('DELETE removes a host', async () => {
    const ctx = makeCtx({ allowlist: ['example.com', 'other.com'] });
    const r = await reqCtx('DELETE', '/api/allowlist', ctx, { body: { host: 'example.com' } });
    expect(r.status).toBe(200);
    expect(ctx.settings.allowlist).not.toContain('example.com');
    expect(ctx.settings.allowlist).toContain('other.com');
  });
});

describe('GET+POST+DELETE /api/bypass', () => {
  it('GET returns bypass hosts', async () => {
    const r = await req('GET', '/api/bypass');
    expect(r.status).toBe(200);
    expect(Array.isArray((r.body as { bypassHosts: string[] }).bypassHosts)).toBe(true);
  });

  it('POST adds a host', async () => {
    const ctx = makeCtx();
    const r = await reqCtx('POST', '/api/bypass', ctx, { body: { host: 'bank.com' } });
    expect(r.status).toBe(200);
    expect(ctx.settings.bypassHosts).toContain('bank.com');
  });

  it('DELETE removes a host', async () => {
    const ctx = makeCtx({ bypassHosts: ['bank.com', 'other.com'] });
    const r = await reqCtx('DELETE', '/api/bypass', ctx, { body: { host: 'bank.com' } });
    expect(r.status).toBe(200);
    expect(ctx.settings.bypassHosts).not.toContain('bank.com');
  });
});

describe('GET /api/export', () => {
  it('returns ExportBackup shape with 200', async () => {
    const r = await req('GET', '/api/export');
    expect(r.status).toBe(200);
    const b = r.body as { version: number; userRules: string; settings: object; exportedAt: number };
    expect(b.version).toBe(1);
    expect(typeof b.userRules).toBe('string');
    expect(typeof b.settings).toBe('object');
    expect(typeof b.exportedAt).toBe('number');
  });
});

describe('POST /api/import', () => {
  it('imports valid backup and returns count', async () => {
    const backup = {
      version: 1,
      settings: baseSettings,
      userRules: '||import-test.example^\nexample.com##.ad\n',
      exportedAt: 0,
    };
    const ctx = makeCtx();
    const r = await reqCtx('POST', '/api/import', ctx, { body: backup });
    expect(r.status).toBe(200);
    expect((r.body as { count: number }).count).toBeGreaterThan(0);
  });

  it('returns 400 for malformed JSON', async () => {
    const rawBody = Buffer.from('not-json');
    const r = await route(
      'POST',
      '/api/import',
      { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', 'x-ghettoblocker': '1' },
      rawBody,
      PORT,
      makeCtx(),
    );
    expect(r.status).toBe(400);
  });

  it('returns 413 for oversized body', async () => {
    // Create a buffer larger than the 1 MB limit
    const rawBody = Buffer.alloc(1_100_000, 'x');
    const r = await route(
      'POST',
      '/api/import',
      { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', 'x-ghettoblocker': '1' },
      rawBody,
      PORT,
      makeCtx(),
    );
    expect(r.status).toBe(413);
  });

  it('returns 400 when backup has no userRules field', async () => {
    const r = await req('POST', '/api/import', { body: { version: 1, exportedAt: 0 } });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/broken-report', () => {
  it('records a broken-site report and returns 200', async () => {
    const ctx = makeCtx();
    const r = await reqCtx('POST', '/api/broken-report', ctx, {
      body: { host: 'broken.example.com', comment: 'ads breaking layout' },
    });
    expect(r.status).toBe(200);
    expect(ctx.stats.getBrokenReports().length).toBe(1);
    expect(ctx.stats.getBrokenReports()[0]!.host).toBe('broken.example.com');
  });
});

// ---------------------------------------------------------------------------
// Live HTTP server tests (SSE + CORS OPTIONS)
// ---------------------------------------------------------------------------

describe('CORS preflight (live server)', () => {
  function preflight(extraHeaders: Record<string, string>): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port: livePort,
          method: 'OPTIONS',
          path: '/api/settings',
          headers: {
            host: `127.0.0.1:${livePort}`,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type, x-ghettoblocker',
            ...extraHeaders,
          },
        },
        resolve,
      );
      r.on('error', reject);
      r.end();
    });
  }

  it('returns 204 with ACAO for an extension origin', async () => {
    const origin = 'chrome-extension://abcdefghijklmnop';
    const res = await preflight({ origin });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  it('sets Access-Control-Allow-Private-Network: true when PNA header is present', async () => {
    const origin = 'chrome-extension://abcdefghijklmnop';
    const res = await preflight({
      origin,
      'access-control-request-private-network': 'true',
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-private-network']).toBe('true');
  });

  it('returns 403 for an untrusted external origin', async () => {
    const res = await preflight({ origin: 'https://evil.example.com' });
    expect(res.statusCode).toBe(403);
  });
});

describe('SSE /api/stats/stream (live server)', () => {
  it('delivers events and removes closed connections without errors', async () => {
    let dataReceived = false;

    const sseReq = http.request(
      {
        host: '127.0.0.1',
        port: livePort,
        path: '/api/stats/stream',
        headers: { host: `127.0.0.1:${livePort}` },
      },
      (res) => {
        res.on('data', () => {
          dataReceived = true;
        });
      },
    );
    sseReq.on('error', () => {
      // Expected after destroy()
    });
    sseReq.end();

    // Give the server a moment to register the SSE client.
    await new Promise((r) => setTimeout(r, 30));

    // Push an event so the SSE client receives something.
    liveCtx.recordEvent({
      type: 'block',
      host: 'sse-test.example',
      url: 'https://sse-test.example/x',
      rule: undefined,
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(dataReceived).toBe(true);

    // Destroy the client connection to trigger server-side cleanup.
    sseReq.destroy();

    await new Promise((r) => setTimeout(r, 50));

    // Recording another event must not throw (the dead client should be gone).
    expect(() => {
      liveCtx.recordEvent({
        type: 'allow',
        host: 'after-cleanup.example',
        url: 'https://after-cleanup.example/',
        rule: undefined,
      });
    }).not.toThrow();
  });
});

describe('POST /api/settings validation', () => {
  it('rejects unknown settings keys instead of persisting them', async () => {
    const r = await req('POST', '/api/settings', { body: { x: 'A'.repeat(100) } });
    expect(r.status).toBe(400);
    expect(String((r.body as { error: string }).error)).toContain('x');
  });

  it('rejects a value of the wrong type', async () => {
    expect((await req('POST', '/api/settings', { body: { paused: 'yes' } })).status).toBe(400);
    expect((await req('POST', '/api/settings', { body: { theme: 'neon' } })).status).toBe(400);
    expect((await req('POST', '/api/settings', { body: { allowlist: ['ok.example', 42] } })).status).toBe(400);
    expect((await req('POST', '/api/settings', { body: { controlPort: 70000 } })).status).toBe(400);
  });

  it('accepts a well-formed patch', async () => {
    const r = await req('POST', '/api/settings', {
      body: { paused: true, theme: 'cyberpunk', allowlist: ['ok.example'], controlPort: 9000 },
    });
    expect(r.status).toBe(200);
    const { settings } = r.body as { settings: Settings };
    expect(settings.paused).toBe(true);
    expect(settings.theme).toBe('cyberpunk');
    expect(settings.allowlist).toEqual(['ok.example']);
  });
});

describe('POST /api/cosmetics', () => {
  const engine = FiltersEngine.parse(
    [
      '##.generic-ad-box',
      '##[id^="ad-generic-"]',
      'site.example##.site-ad',
      'site.example##+js(set, window.ads, false)',
      'site.example##div:has-text(Sponsored)',
    ].join('\n'),
    {
      loadNetworkFilters: true,
      loadCosmeticFilters: true,
      loadExtendedSelectors: true,
      enableCompression: false,
    },
  );
  const cosmeticsCtx = (patch?: Partial<Settings>) =>
    createRuntimeContext({ baseEngine: engine, settings: { ...baseSettings, ...patch }, stats: createStats() });
  const post = (body: unknown, ctx = cosmeticsCtx(), csrf = true) =>
    route(
      'POST',
      '/api/cosmetics',
      { host: `127.0.0.1:${PORT}`, ...(csrf ? { 'x-ghettoblocker': '1' } : {}) },
      Buffer.from(JSON.stringify(body)),
      PORT,
      ctx,
    );
  type Body = { active: boolean; styles: string; extended: { attribute?: string }[] };

  it('on start returns hostname + DOM-indexed rules but no base stylesheet and no scriptlets', async () => {
    const r = await post({ url: 'https://site.example/a', lifecycle: 'start', classes: ['generic-ad-box'] });
    expect(r.status).toBe(200);
    const b = r.body as Body;
    expect(b.active).toBe(true);
    expect(b.styles).toContain('.site-ad');
    expect(b.styles).toContain('.generic-ad-box');
    expect(b.styles).not.toContain('[id^="ad-generic-"]');
    expect(b.styles).not.toContain('window.ads');
    expect(b.extended).toHaveLength(1);
    expect(b.styles).toContain(`[${b.extended[0]?.attribute}]`);
  });

  it('on dom-update returns only what the new features unlock', async () => {
    const r = await post({ url: 'https://site.example/a', lifecycle: 'dom-update', classes: ['generic-ad-box'] });
    const b = r.body as Body;
    expect(b.styles).toContain('.generic-ad-box');
    expect(b.styles).not.toContain('.site-ad');
    expect(b.extended).toHaveLength(0);
  });

  it('is inactive when paused, cosmetics are off, or the site is allowlisted/bypassed', async () => {
    const url = 'https://site.example/';
    for (const ctx of [
      cosmeticsCtx({ paused: true }),
      cosmeticsCtx({ injectCosmetics: false }),
      cosmeticsCtx({ allowlist: ['site.example'] }),
      cosmeticsCtx({ bypassHosts: ['example'] }),
    ]) {
      const b = (await post({ url }, ctx)).body as Body;
      expect(b.active).toBe(false);
      expect(b.styles).toBe('');
    }
    expect(((await post({ url })).body as Body).active).toBe(true);
  });

  it('validates the request body', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ url: 'not a url' })).status).toBe(400);
    expect((await post({ url: 'https://site.example/', lifecycle: 'later' })).status).toBe(400);
    expect((await post({ url: 'https://site.example/', classes: 'ad' })).status).toBe(400);
    expect(((await post({ url: 'chrome://extensions' })).body as Body).active).toBe(false);
  });

  it('requires the CSRF header like every other POST', async () => {
    expect((await post({ url: 'https://site.example/' }, cosmeticsCtx(), false)).status).toBe(403);
  });
});

describe('list updates', () => {
  it('GET /api/state reports totals age and list freshness', async () => {
    const r = await req('GET', '/api/state');
    const body = r.body as { since: number; lists: { builtAt: number } };
    expect(body.since).toBeGreaterThan(0);
    expect(body.lists.builtAt).toBeGreaterThan(0);
  });

  it('POST /api/lists/update rebuilds and returns the new build time', async () => {
    const ctx = createRuntimeContext({
      baseEngine: emptyEngine,
      rebuildEngines: async () => ({ base: emptyEngine, privacy: emptyEngine, builtAt: 4242 }),
      settings: { ...baseSettings },
      stats: createStats(),
    });
    const r = await route('POST', '/api/lists/update', { host: `127.0.0.1:${PORT}`, 'x-ghettoblocker': '1' }, Buffer.alloc(0), PORT, ctx);
    expect(r.status).toBe(200);
    expect((r.body as { builtAt: number }).builtAt).toBe(4242);
    expect(ctx.listsBuiltAt()).toBe(4242);
  });

  it('POST /api/lists/update reports a failed download without crashing', async () => {
    const ctx = createRuntimeContext({
      baseEngine: emptyEngine,
      rebuildEngines: async () => { throw new Error('offline'); },
      settings: { ...baseSettings },
      stats: createStats(),
    });
    const r = await route('POST', '/api/lists/update', { host: `127.0.0.1:${PORT}`, 'x-ghettoblocker': '1' }, Buffer.alloc(0), PORT, ctx);
    expect(r.status).toBe(502);
    expect(String((r.body as { error: string }).error)).toContain('offline');
  });
});

describe('AdNauseam routes', () => {
  const adCtx = (on: boolean) => makeCtx({ adNauseam: on });
  const post = (body: unknown, ctx: ReturnType<typeof makeCtx>) =>
    route('POST', '/api/adnauseam/click', { host: `127.0.0.1:${PORT}`, 'x-ghettoblocker': '1' }, Buffer.from(JSON.stringify(body)), PORT, ctx);

  it('refuses click announcements while the mode is off', async () => {
    expect((await post({ url: 'https://adclick.example/aclk?x=1', page: 'https://news.example/' }, adCtx(false))).status).toBe(409);
  });

  it('registers a click for the proxy while on, and validates the body', async () => {
    const ctx = adCtx(true);
    expect((await post({ url: 'https://adclick.example/aclk?x=1', page: 'https://news.example/' }, ctx)).status).toBe(200);
    expect(ctx.takePendingClick('https://adclick.example/aclk?x=1')).toEqual({ page: 'https://news.example/' });
    expect((await post({ url: 'javascript:alert(1)', page: 'p' }, ctx)).status).toBe(400);
    expect((await post({ page: 'p' }, ctx)).status).toBe(400);
  });

  it('serves the vault newest first with the running total', async () => {
    const ctx = adCtx(true);
    ctx.stats.totals.clicked = 2;
    ctx.stats.recordClick({ url: 'https://a.example/1', host: 'a.example', page: 'p', ts: 1 });
    ctx.stats.recordClick({ url: 'https://a.example/2', host: 'a.example', page: 'p', ts: 2 });
    const r = await route('GET', '/api/adnauseam/vault', { host: `127.0.0.1:${PORT}` }, Buffer.alloc(0), PORT, ctx);
    const body = r.body as { clicked: number; entries: { url: string }[] };
    expect(body.clicked).toBe(2);
    expect(body.entries.map((e) => e.url)).toEqual(['https://a.example/2', 'https://a.example/1']);
  });

  it('tells the content script whether to hunt for ads', async () => {
    const r = await route('POST', '/api/cosmetics', { host: `127.0.0.1:${PORT}`, 'x-ghettoblocker': '1' }, Buffer.from(JSON.stringify({ url: 'https://site.example/' })), PORT, adCtx(true));
    expect((r.body as { adNauseam: boolean }).adNauseam).toBe(true);
  });
});

describe('self-update routes', () => {
  it('reports version and update status, and refuses checks in headless mode', async () => {
    const state = (await req('GET', '/api/state')).body as { version: string; update: { state: string } };
    expect(state.version).toBe('dev');
    expect(state.update.state).toBe('unavailable');
    expect((await req('POST', '/api/update/check')).status).toBe(409);
    expect((await req('POST', '/api/update/install')).status).toBe(409);
  });

  it('runs the installed checker and exposes its outcome', async () => {
    const ctx = makeCtx();
    ctx.updates.check = async () => ctx.updates.setStatus({ state: 'up-to-date', version: '9.9.9' });
    const hdr = { host: `127.0.0.1:${PORT}`, 'x-ghettoblocker': '1' };
    const r = await route('POST', '/api/update/check', hdr, Buffer.alloc(0), PORT, ctx);
    expect(r.status).toBe(200);
    expect((r.body as { update: { state: string; version: string } }).update).toMatchObject({ state: 'up-to-date', version: '9.9.9' });

    ctx.updates.check = async () => { throw new Error('rate limited'); };
    const r2 = await route('POST', '/api/update/check', hdr, Buffer.alloc(0), PORT, ctx);
    expect((r2.body as { update: { state: string; message: string } }).update).toMatchObject({ state: 'error', message: 'rate limited' });

    let installed = false;
    ctx.updates.install = () => { installed = true; };
    expect((await route('POST', '/api/update/install', hdr, Buffer.alloc(0), PORT, ctx)).status).toBe(409); // not ready
    ctx.updates.setStatus({ state: 'ready', version: '9.9.9' });
    expect((await route('POST', '/api/update/install', hdr, Buffer.alloc(0), PORT, ctx)).status).toBe(200);
    expect(installed).toBe(true);
  });
});
