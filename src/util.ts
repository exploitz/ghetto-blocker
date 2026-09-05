import type { IncomingHttpHeaders } from 'node:http';
import * as zlib from 'node:zlib';
const { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } = zlib;
import type { RequestType } from '@ghostery/adblocker';

/** Cosmetic payload returned by the adblocker engine (subset we use). */
export interface CosmeticPayload {
  styles: string;
  scripts: string[];
}

/** Reconstruct the absolute request URL from an intercepted (possibly relative) request. */
export function buildAbsoluteUrl(isSSL: boolean, host: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${isSSL ? 'https' : 'http'}://${host}${path}`;
}

/** Best-effort map from request headers to an adblocker resource type. */
export function guessResourceType(headers: IncomingHttpHeaders, url: string): RequestType {
  const dest = String(headers['sec-fetch-dest'] ?? '').toLowerCase();
  switch (dest) {
    case 'document':
      return 'main_frame';
    case 'iframe':
    case 'frame':
      return 'sub_frame';
    case 'script':
      return 'script';
    case 'style':
      return 'stylesheet';
    case 'image':
      return 'image';
    case 'font':
      return 'font';
    case 'audio':
    case 'video':
    case 'track':
      return 'media';
    case 'object':
    case 'embed':
      return 'object';
    case 'empty':
      return 'xmlhttprequest';
  }

  const path = (url.split('?')[0] ?? '').toLowerCase();
  if (/\.(?:js|mjs|cjs)$/.test(path)) return 'script';
  if (/\.css$/.test(path)) return 'stylesheet';
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)$/.test(path)) return 'image';
  if (/\.(?:woff2?|ttf|otf|eot)$/.test(path)) return 'font';
  if (/\.(?:mp4|webm|ogg|mp3|wav|m4a|m4v)$/.test(path)) return 'media';

  const accept = String(headers['accept'] ?? '').toLowerCase();
  if (accept.includes('text/html')) return 'main_frame';
  if (accept.includes('text/css')) return 'stylesheet';
  if (accept.startsWith('image/')) return 'image';
  return 'other';
}

/** Decode a `data:` URL (used for adblocker resource redirects) into bytes. */
export function parseDataUrl(dataUrl: string): { contentType: string; body: Buffer } | null {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  const meta = match[1] ?? '';
  const data = match[2] ?? '';
  const isBase64 = /;base64$/i.test(meta);
  const contentType = (isBase64 ? meta.replace(/;base64$/i, '') : meta) || 'text/plain';
  const body = isBase64
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data), 'utf8');
  return { contentType, body };
}

/**
 * Give one scriptlet its own function scope, the way uBlock Origin and the
 * Ghostery extension run them. Each scriptlet ships its own copy of shared
 * helpers (`class JSONPath`, `function proxyApplyFn`, ...); dumped into the
 * page's global scope they collide: the second `class JSONPath` is a
 * SyntaxError, and a second `proxyApplyFn` re-wraps `Function.prototype.toString`
 * on top of its own earlier wrapper and recurses until the stack overflows.
 * The try/catch keeps one failing scriptlet from taking the others down.
 */
export function wrapScriptlet(body: string): string {
  return `(function(){try{${body}\n}catch(e){}})();`;
}

/** Build the `<style>`/`<script>` HTML blob to inject from a cosmetic payload. */
export function buildInjectionBlob(payload: CosmeticPayload): string {
  const parts: string[] = [];
  const styles = (payload.styles ?? '').trim();
  if (styles) {
    parts.push(`<style type="text/css" id="ghetto-blocker-cosmetics">${styles}</style>`);
  }
  for (const script of payload.scripts ?? []) {
    const body = (script ?? '').trim();
    if (body) parts.push(`<script type="text/javascript">${wrapScriptlet(body)}</script>`);
  }
  return parts.join('');
}

/**
 * Offset at which to splice injected markup: just before `</head>`, else just
 * after `<head>`, else just after `<body>`. Returns -1 when no anchor is present.
 *
 * End of head rather than start: React apps that render their own `<head>`
 * (Next.js) hydrate its children in order, and a foreign `<script>` placed
 * before their first inline script gets paired with it and reported as a
 * hydration mismatch (React error #418). After their nodes we are just extra.
 */
export function findInjectionOffset(html: string): number {
  const headClose = html.search(/<\/head\s*>/i);
  if (headClose >= 0) return headClose;
  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen) return headOpen.index + headOpen[0].length;
  const bodyOpen = /<body[^>]*>/i.exec(html);
  if (bodyOpen) return bodyOpen.index + bodyOpen[0].length;
  return -1;
}

/** Inject a cosmetic payload into a full HTML string (used in tests + buffered mode). */
export function injectIntoHtml(html: string, payload: CosmeticPayload): string {
  const blob = buildInjectionBlob(payload);
  if (!blob) return html;
  const at = findInjectionOffset(html);
  if (at < 0) return blob + html;
  return html.slice(0, at) + blob + html.slice(at);
}

/**
 * Byte-preserving variant of injectIntoHtml. The page bytes are never
 * transcoded (a windows-1252 or Shift_JIS document stays intact); the
 * markup is spliced in at a byte offset located on a latin1 view, which maps
 * bytes 1:1 and is enough to find the ASCII `<head>` / `<body>` tags.
 */
export function injectIntoHtmlBytes(bytes: Buffer, payload: CosmeticPayload): Buffer {
  const blob = buildInjectionBlob(payload);
  if (!blob) return bytes;
  const at = findInjectionOffset(bytes.toString('latin1'));
  const blobBytes = Buffer.from(blob, 'utf8');
  if (at < 0) return Buffer.concat([blobBytes, bytes]);
  return Buffer.concat([bytes.subarray(0, at), blobBytes, bytes.subarray(at)]);
}

/** Strip the port from a Host header value, handling bracketed IPv6. */
export function hostnameWithoutPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end) : host;
  }
  const colon = host.indexOf(':');
  return colon >= 0 ? host.slice(0, colon) : host;
}

/** True when this Node/Electron runtime ships a zstd decoder (Node >= 22.15). */
export const ZSTD_SUPPORTED = typeof zlib.zstdDecompressSync === 'function';

/** Content-encodings we can decode in order to inject into a response body. */
export function canDecompress(encoding: string): boolean {
  const e = encoding.trim().toLowerCase();
  if (e === 'zstd') return ZSTD_SUPPORTED;
  return e === '' || e === 'identity' || e === 'gzip' || e === 'x-gzip' || e === 'br' || e === 'deflate';
}

/**
 * Remove `zstd` from an Accept-Encoding header value so upstream servers fall
 * back to gzip/br, which every supported runtime can decode. Chromium
 * advertises zstd and Cloudflare-fronted sites honour it; a zstd HTML body we
 * cannot decode would have to be passed through with no cosmetics injected.
 */
export function stripZstdFromAcceptEncoding(value: string): string {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && (t.split(';')[0] ?? '').trim().toLowerCase() !== 'zstd')
    .join(', ');
}

/** Decode a response body for a known `content-encoding`. Throws on bad data. */
export function decompressBody(body: Buffer, encoding: string): Buffer {
  switch (encoding.trim().toLowerCase()) {
    case '':
    case 'identity':
      return body;
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(body);
    case 'br':
      return brotliDecompressSync(body);
    case 'zstd':
      if (!ZSTD_SUPPORTED) throw new Error('zstd not supported by this runtime');
      return zlib.zstdDecompressSync(body);
    case 'deflate':
      // Some servers send raw (headerless) deflate; fall back to that.
      try {
        return inflateSync(body);
      } catch {
        return inflateRawSync(body);
      }
    default:
      throw new Error(`unsupported content-encoding: ${encoding}`);
  }
}

/** True if `host` exactly equals or is a subdomain of any bypass entry. */
export function isBypassed(host: string, bypassHosts: string[]): boolean {
  const h = hostnameWithoutPort(host).toLowerCase();
  return bypassHosts.some((entry) => {
    const e = entry.toLowerCase();
    return h === e || h.endsWith(`.${e}`);
  });
}

/** Class names, ids and hrefs present in a document -- the keys the engine's generic cosmetic indexes are looked up by. */
export interface DomFeatures {
  classes: string[];
  ids: string[];
  hrefs: string[];
}

/** Upper bound per feature set so a pathological multi-megabyte page cannot balloon the engine lookup. */
const DOM_FEATURE_CAP = 4096;

const ATTR_RE = /\s(class|id|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/**
 * Scan raw HTML for class/id/href attribute values without building a DOM.
 * Over-collection (e.g. a `class="..."` literal inside an inline script) is
 * harmless: it only makes the engine return a hide rule for a class that may
 * never appear, and the rule matches nothing.
 */
export function extractDomFeatures(html: string): DomFeatures {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const hrefs = new Set<string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(html)) !== null) {
    const name = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (!value) continue;
    if (name === 'class') {
      for (const c of value.split(/\s+/)) {
        if (c && classes.size < DOM_FEATURE_CAP) classes.add(c);
      }
    } else if (name === 'id') {
      const id = value.trim();
      if (id && ids.size < DOM_FEATURE_CAP) ids.add(id);
    } else if (hrefs.size < DOM_FEATURE_CAP) {
      hrefs.add(value);
    }
  }
  return { classes: [...classes], ids: [...ids], hrefs: [...hrefs] };
}

/** Tracking query-parameters to remove from request URLs (GET-only 302 redirect path). */
const TRACKING_PARAMS = new Set([
  // Google Analytics utm_* family (utm_id added for GA4 support)
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'dclid', 'gbraid', 'wbraid',
  'mc_eid', 'igshid', '_hsenc', '_hsmi', 'yclid', 'ttclid',
]);

/**
 * Remove known tracking query params from a URL.
 * Returns the (possibly rewritten) URL and whether any params were removed.
 */
export function stripTrackingParams(url: string): { url: string; changed: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, changed: false };
  }

  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }

  return { url: changed ? parsed.toString() : url, changed };
}
