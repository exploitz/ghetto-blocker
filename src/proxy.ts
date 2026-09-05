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
      stats.recordClick({ url, host: hostname, page: click.page, ts: Date.now() });
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
    'x-ghetto-blocker': 'block',
  });
  icontext.proxyToClientResponse.end();
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
