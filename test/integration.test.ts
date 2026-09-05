import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import net from 'node:net';
import { FiltersEngine } from '@ghostery/adblocker';
import { createProxy } from '../src/proxy.js';
import { createRuntimeContext } from '../src/runtime.js';
import { createStats } from '../src/state.js';
import type { Settings } from '../src/state.js';
import { ZSTD_SUPPORTED } from '../src/util.js';

const baseEngine = FiltersEngine.parse(
  ['/ads/track.js', '127.0.0.1##.ad-test', '##.generic-ad', '##.unused-generic-ad'].join('\n'),
  { loadNetworkFilters: true, loadCosmeticFilters: true, enableCompression: false },
);

const testSettings: Settings = {
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
let lastUpstreamHeaders: http.IncomingHttpHeaders = {};
let upstream: http.Server;
let upstreamPort = 0;
let proxyPort = 0;
let proxy: ReturnType<typeof createProxy>['proxy'];
let ctx: ReturnType<typeof createRuntimeContext>;

beforeAll(async () => {
  // Point persistence at a temp dir so tests never touch ~/.ghetto-blocker.
  testDataDir = await mkdtemp(join(tmpdir(), 'ghetto-integration-test-'));
  process.env['GHETTO_DATA_DIR'] = testDataDir;

  upstream = http.createServer((req, res) => {
    lastUpstreamHeaders = req.headers;
    if (req.url?.startsWith('/ads/track.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('console.log("tracker ran");');
      return;
    }
    const html =
      '<html><head><title>t</title></head><body><div class="ad-test">AD</div>' +
      '<div class="generic-ad">GENERIC</div></body></html>';
    const zstd = req.url?.startsWith('/zstd.html') === true;
    const body = zstd ? zstdCompressSync(Buffer.from(html)) : gzipSync(Buffer.from(html));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': zstd ? 'zstd' : 'gzip',
      etag: 'W/"page-v1"',
      'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
      'cache-control': 'private, no-cache',
      'content-length': String(body.length),
      'content-security-policy': "default-src 'self'",
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;

  ctx = createRuntimeContext({ baseEngine, settings: { ...testSettings }, stats: createStats() });
  const built = createProxy(ctx);
  proxy = built.proxy;
  await new Promise<void>((resolve) =>
    proxy.listen(
      { port: 0, host: '127.0.0.1', sslCaDir: join(testDataDir, 'ca') },
      () => resolve(),
    ),
  );
  proxyPort = proxy.httpPort;
});

afterAll(async () => {
  proxy.close();
  upstream.close();
  delete process.env['GHETTO_DATA_DIR'];
  await rm(testDataDir, { recursive: true, force: true });
});

function viaProxy(
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        // Absolute-form request-target routes through the forward proxy.
        path: `http://127.0.0.1:${upstreamPort}${path}`,
        headers: { host: `127.0.0.1:${upstreamPort}`, ...extraHeaders },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('proxy integration over HTTP', () => {
  it('blocks a request matching a network filter and marks the response for the badge', async () => {
    const res = await viaProxy('/ads/track.js');
    expect(res.body).not.toContain('tracker ran');
    expect(res.body.length).toBe(0);
    expect(res.headers['x-ghetto-blocker']).toBe('block');
    expect((await viaProxy('/page.html')).headers['x-ghetto-blocker']).toBeUndefined();
  });

  it('passes HTML through and injects cosmetic CSS', async () => {
    const res = await viaProxy('/page.html');
    expect(res.body).toContain('AD'); // original page content survived
    expect(res.body).toContain('ghetto-blocker-cosmetics'); // our injection is present
    expect(res.body).toContain('.ad-test'); // the hostname-specific hiding rule
  });

  it('injects the generic rules unlocked by the classes present in the page, and only those', async () => {
    const res = await viaProxy('/page.html');
    expect(res.body).toContain('.generic-ad');
    expect(res.body).not.toContain('.unused-generic-ad');
  });

  it('decodes a zstd-encoded document and still injects cosmetics', async () => {
    if (!ZSTD_SUPPORTED) return;
    const res = await viaProxy('/zstd.html');
    expect(res.body).toContain('GENERIC');
    expect(res.body).toContain('ghetto-blocker-cosmetics');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('makes rewritten documents uncacheable and never revalidates them upstream', async () => {
    const res = await viaProxy('/page.html', {
      accept: 'text/html',
      'if-none-match': 'W/"page-v1"',
      'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    expect(res.status).toBe(200); // a 304 here would have resurrected a cached, injected copy
    expect(lastUpstreamHeaders['if-none-match']).toBeUndefined();
    expect(lastUpstreamHeaders['if-modified-since']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['etag']).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
    // Blocked responses are not cacheable either, so pausing takes effect on reload.
    expect((await viaProxy('/ads/track.js')).headers['cache-control']).toBe('no-store');
  });

  it('strips CSP so injected styles are allowed to run', async () => {
    const res = await viaProxy('/page.html');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('tracks block and injection stats', () => {
    expect(ctx.stats.totals.blocked).toBeGreaterThanOrEqual(1);
    expect(ctx.stats.totals.injected).toBeGreaterThanOrEqual(1);
  });

  it('redirects GET requests with tracking params (anti-analytics)', async () => {
    const res = await viaProxy('/page.html?utm_source=email&utm_campaign=test&q=hello');
    expect(res.status).toBe(302);
    const loc = res.headers['location'] ?? '';
    expect(loc).not.toContain('utm_source');
    expect(loc).not.toContain('utm_campaign');
    // Non-tracking params survive the redirect
    expect(loc).toContain('q=hello');
    expect(ctx.stats.totals.poisoned).toBeGreaterThanOrEqual(1);
  });

  it('lets an announced AdNauseam click through untouched and counts it', async () => {
    await ctx.updateSettings({ adNauseam: true });
    try {
      const clickUrl = `http://127.0.0.1:${upstreamPort}/ads/track.js?gclid=abc&utm_source=x`;
      // Not announced: blocked like any ad request would be with the full engine... but in
      // AdNauseam mode ads load, so this one is only stripped of its tracking params.
      const plain = await viaProxy('/ads/track.js?gclid=abc&utm_source=x');
      expect(plain.status).toBe(302);

      ctx.registerPendingClick(clickUrl, 'https://news.example/');
      const before = ctx.stats.totals.clicked;
      const res = await viaProxy('/ads/track.js?gclid=abc&utm_source=x');
      expect(res.status).toBe(200);
      expect(res.body).toContain('tracker ran'); // reached the upstream with its params intact
      expect(ctx.stats.totals.clicked).toBe(before + 1);
      expect(ctx.stats.getVault()[0]).toMatchObject({ page: 'https://news.example/', url: clickUrl });
    } finally {
      await ctx.updateSettings({ adNauseam: false });
    }
  });

  it('tunnels a bypass host raw: bytes pass through untouched, no MITM', async () => {
    // A plain TCP echo origin. A raw CONNECT tunnel splices client<->origin, so
    // whatever we send comes straight back; the proxy never sees or rewrites it.
    const echo = net.createServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const echoPort = (echo.address() as AddressInfo).port;
    await ctx.updateSettings({ bypassHosts: ['127.0.0.1'] });
    try {
      const roundtrip = await new Promise<string>((resolve, reject) => {
        const raw = net.connect(proxyPort, '127.0.0.1', () => {
          raw.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
        });
        let established = false;
        let out = '';
        raw.on('data', (chunk) => {
          if (!established) {
            const text = chunk.toString('latin1');
            expect(text).toMatch(/^HTTP\/1\.1 200/); // tunnel opened
            established = true;
            raw.write('PING-THROUGH-RAW-TUNNEL');
            return;
          }
          out += chunk.toString('latin1');
          if (out.includes('PING-THROUGH-RAW-TUNNEL')) resolve(out);
        });
        raw.on('error', reject);
        setTimeout(() => reject(new Error('no echo; established=' + established)), 5000);
      });
      expect(roundtrip).toBe('PING-THROUGH-RAW-TUNNEL');
    } finally {
      echo.close();
      await ctx.updateSettings({ bypassHosts: [] });
    }
  });

  it('passes blocked requests through when globally paused', async () => {
    await ctx.updateSettings({ paused: true });
    try {
      const res = await viaProxy('/ads/track.js');
      expect(res.body).toContain('tracker ran');
    } finally {
      // Always restore so later tests are not affected.
      await ctx.updateSettings({ paused: false });
    }
  });
});
