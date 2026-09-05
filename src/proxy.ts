import net from 'node:net';
import { Proxy } from 'http-mitm-proxy';
import type { IContext } from 'http-mitm-proxy';
import { parse as parseDomain } from 'tldts';
import type { RuntimeContext } from './runtime.js';
import {
  ZSTD_SUPPORTED,
  buildAbsoluteUrl,
  canDecompress,
  decompressBody,
  extractDomFeatures,
  guessResourceType,
  hostnameWithoutPort,
  injectIntoHtmlBytes,
  isBypassed,
  parseDataUrl,
  stripTrackingParams,
  stripZstdFromAcceptEncoding,
} from './util.js';

/** Build (but do not start) the filtering MITM proxy. */
export function createProxy(ctx: RuntimeContext): { proxy: Proxy } {
  const proxy = new Proxy();

  // Bypass hosts are tunneled RAW: the CONNECT is spliced straight to the
  // origin with no TLS interception, so the browser gets the real certificate,
  // native HTTP/2, and an untouched byte stream. This is what makes
  // cert-pinned apps and MITM-sensitive sites (some streaming apps) work, and
  // it is the only way to guarantee a site behaves exactly as it would with no
  // proxy at all. Returning without calling `callback` stops the library's
  // default decrypt-and-inspect path for this connection.
  proxy.onConnect((req, socket, head, callback) => {
    const target = String(req.url ?? '');
    const sep = target.lastIndexOf(':');
    const host = sep >= 0 ? target.slice(0, sep) : target;
    const port = sep >= 0 ? Number(target.slice(sep + 1)) : 443;
    // Only bypass hosts tunnel raw; everything else takes the normal MITM path
    // (where the paused / allowlist checks decide what is filtered).
    if (!host || !Number.isInteger(port) || !isBypassed(host, ctx.settings.bypassHosts)) {
      return callback();
    }
    const upstream = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const drop = (): void => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', drop);
    socket.on('error', drop);
    // Do NOT call callback(): that would hand the connection to the MITM path.
  });

  proxy.onError((icontext, err) => {
    // Client/server socket resets are common and benign; don't spam the log.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED') return;
    const url = icontext?.clientToProxyRequest?.url ?? '';
    console.warn(`[proxy] error on ${url}: ${err?.message ?? String(err)}`);
  });

  proxy.onRequest((icontext, callback) => {
    const { settings, stats } = ctx;
    const req = icontext.clientToProxyRequest;
    const host = req.headers.host ?? '';

    // Documents we may have rewritten must never be revalidated back out of
    // the browser cache (a 304 would resurrect a copy with cosmetics baked
    // in, e.g. after pausing). Ask upstream for the full body every time.
    // Done before the pause check so a stale injected copy dies while paused.
    if (isDocumentRequest(req.headers)) {
      const outHeaders = icontext.proxyToServerRequestOptions?.headers;
      if (outHeaders) {
        delete outHeaders['if-none-match'];
        delete outHeaders['if-modified-since'];
      }
    }

    if (ctx.setup.trafficSeenAt === null && !/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)) {
      ctx.setup.trafficSeenAt = Date.now();
    }

    // Globally paused: pass everything through unfiltered.
    if (settings.paused) return callback();

    // Bypass: cert-pinned / banking apps that must not be MITM'd.
    if (isBypassed(host, settings.bypassHosts)) return callback();

    // Allowlist: sites the user has explicitly chosen to allow.
    if (isBypassed(host, settings.allowlist)) return callback();

    const url = buildAbsoluteUrl(icontext.isSSL, host, req.url ?? '');
    const sourceUrl = typeof req.headers.referer === 'string' ? req.headers.referer : '';
    const type = guessResourceType(req.headers, url);
    const hostname = hostnameWithoutPort(host);

    // AdNauseam: a click the extension announced goes out untouched (no
    // filtering, no tracking-param stripping -- the click ids are the point).
    const click = ctx.takePendingClick(url);
    if (click) {
      stats.totals.clicked++;
      stats.recordClick({
        url,
        host: hostname,
        page: click.page,
        ts: Date.now(),
        ...(click.image ? { image: click.image } : {}),
        ...(click.title ? { title: click.title } : {}),
      });
      ctx.recordEvent({ type: 'click', host: hostname, url, rule: undefined });
      return callback();
    }

    // Anti-analytics: GET-only 302 redirect to strip tracking query params.
    if (settings.antiAnalytics && req.method === 'GET') {
      const cleaned = stripTrackingParams(url);
      if (cleaned.changed) {
        stats.totals.poisoned++;
        stats.recordSitePoisoned(hostname);
        ctx.recordEvent({ type: 'poison', host: hostname, url, rule: undefined });
        icontext.proxyToClientResponse.writeHead(302, { location: cleaned.url });
        icontext.proxyToClientResponse.end();
        return;
      }
    }

    // Network filter: block or redirect per the adblocker engine.
    let result;
    try {
      result = ctx.matchRequest({ type, url, sourceUrl });
    } catch {
      return callback();
    }

    if (result.match) {
      stats.totals.blocked++;
      stats.recordSiteBlock(hostname);
      ctx.recordEvent({ type: 'block', host: hostname, url, rule: undefined });
      sendEmpty(icontext);
      return; // do NOT call callback() -- terminates the request
    }

    if (result.redirect) {
      const decoded = parseDataUrl(result.redirect.dataUrl);
      if (decoded) {
        stats.totals.redirected++;
        ctx.recordEvent({ type: 'allow', host: hostname, url, rule: undefined });
        icontext.proxyToClientResponse.writeHead(200, {
          'content-type': decoded.contentType,
          'content-length': String(decoded.body.length),
          'cache-control': 'no-store',
          'x-ghetto-blocker': 'redirect',
        });
        icontext.proxyToClientResponse.end(decoded.body);
        return;
      }
    }

    // Documents must come back in an encoding we can decode, or cosmetics
    // cannot be injected. Only needed on runtimes without a zstd decoder.
    if (!ZSTD_SUPPORTED && settings.injectCosmetics && (type === 'main_frame' || type === 'sub_frame')) {
      const outHeaders = icontext.proxyToServerRequestOptions?.headers;
      const accept = outHeaders?.['accept-encoding'];
      if (outHeaders && typeof accept === 'string') {
        outHeaders['accept-encoding'] = stripZstdFromAcceptEncoding(accept);
      }
    }

    stats.totals.allowed++;
    ctx.recordEvent({ type: 'allow', host: hostname, url, rule: undefined });
    return callback();
  });

  // onResponse must be registered UNCONDITIONALLY; gate internally so the
  // setting can be toggled live without restarting the proxy.
  proxy.onResponse((icontext, callback) =>
    injectCosmetics(icontext, callback, ctx),
  );

  return { proxy };
}

/**
 * Blocked requests get an empty 200 (so pages do not error) plus a marker
 * header the extension's service worker counts per tab for the icon badge.
 */
function sendEmpty(icontext: IContext): void {
  icontext.proxyToClientResponse.writeHead(200, {
    'content-type': 'text/plain',
    'content-length': '0',
    'cache-control': 'no-store',
    'x-ghetto-blocker': 'block',
  });
  icontext.proxyToClientResponse.end();
}

/** Navigations and frames: the requests whose HTML we may rewrite. */
function isDocumentRequest(headers: import('node:http').IncomingHttpHeaders): boolean {
  const dest = String(headers['sec-fetch-dest'] ?? '').toLowerCase();
  if (dest === 'document' || dest === 'iframe' || dest === 'frame') return true;
  return dest === '' && String(headers['accept'] ?? '').includes('text/html');
}

function injectCosmetics(
  icontext: IContext,
  callback: (error?: Error | null) => void,
  ctx: RuntimeContext,
): void {
  const { settings, stats } = ctx;

  // Gate: skip when cosmetics are disabled or the proxy is paused.
  if (!settings.injectCosmetics || settings.paused) return callback();

  const upstream = icontext.serverToProxyResponse;
  if (!upstream) return callback();

  const contentType = String(upstream.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('text/html')) return callback();

  const req = icontext.clientToProxyRequest;
  const host = req.headers.host ?? '';

  // Skip bypass and allowlisted hosts (same checks as onRequest).
  if (!host || isBypassed(host, settings.bypassHosts)) return callback();
  if (isBypassed(host, settings.allowlist)) return callback();

  const encoding = String(upstream.headers['content-encoding'] ?? '');
  if (!canDecompress(encoding)) return callback();

  const url = buildAbsoluteUrl(icontext.isSSL, host, req.url ?? '');
  const hostname = hostnameWithoutPort(host);
  const domain = parseDomain(hostname).domain ?? undefined;

  if (settings.stripCSP) {
    // Relax CSP so our inline <style>/<script> is allowed to execute. This
    // weakens the page's own XSS protection -- an accepted trade-off for a
    // personal blocker (documented in README), gated behind settings.stripCSP.
    delete upstream.headers['content-security-policy'];
    delete upstream.headers['content-security-policy-report-only'];
  }
  // We decode and rewrite the body, so the original framing no longer applies:
  // emit plain, unchunked-length-free output.
  delete upstream.headers['content-length'];
  delete upstream.headers['content-encoding'];
  // The body the browser gets is ours, not the origin's: it must not be cached
  // and revalidated with the origin's validators, or a 304 would bring back
  // injected markup after settings change (pause, allowlist, cosmetics off).
  delete upstream.headers['etag'];
  delete upstream.headers['last-modified'];
  delete upstream.headers['expires'];
  upstream.headers['cache-control'] = 'no-store';

  // Buffer the whole HTML body: the generic cosmetic rules are indexed by the
  // classes/ids/hrefs the document actually contains, so the engine lookup
  // needs the complete markup before anything can be spliced in.
  const chunks: Buffer[] = [];
  icontext.onResponseData((_c, chunk, dataCb) => {
    chunks.push(chunk);
    dataCb(undefined, Buffer.alloc(0)); // swallow; full body written at end
  });
  icontext.onResponseEnd((_c, endCb) => {
    const raw = Buffer.concat(chunks);
    let html: Buffer;
    try {
      html = decompressBody(raw, encoding);
    } catch (err) {
      // SHORTCUT: a decode failure on a known encoding (truncated/odd body) sends
      // the raw bytes with content-encoding already stripped, so the page may
      // render wrong. Rare for valid responses. Upgrade: re-encode on failure.
      // Trigger: a site with consistently corrupted gzip responses.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[proxy] cosmetic injection skipped for ${url}: ${message}`);
      icontext.proxyToClientResponse.write(raw);
      endCb();
      return;
    }

    let out = html;
    try {
      const features = extractDomFeatures(html.toString('latin1'));
      const cosmetics = ctx.getCosmetics({ url, hostname, domain, ...features });
      out = injectIntoHtmlBytes(html, cosmetics);
      if (out !== html) {
        stats.totals.injected++;
        stats.recordSiteHide(hostname);
        ctx.recordEvent({ type: 'hide', host: hostname, url, rule: undefined });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[proxy] cosmetic lookup failed for ${url}: ${message}`);
    }
    icontext.proxyToClientResponse.write(out);
    endCb();
  });

  return callback();
}
