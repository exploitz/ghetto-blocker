import { describe, it, expect } from 'vitest';
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { createContext, runInContext } from 'node:vm';
import {
  ZSTD_SUPPORTED,
  buildAbsoluteUrl,
  buildInjectionBlob,
  canDecompress,
  decompressBody,
  extractDomFeatures,
  findInjectionOffset,
  guessResourceType,
  hostnameWithoutPort,
  injectIntoHtml,
  injectIntoHtmlBytes,
  isBypassed,
  parseDataUrl,
  stripTrackingParams,
  stripZstdFromAcceptEncoding,
} from '../src/util';

describe('buildAbsoluteUrl', () => {
  it('reconstructs an https url for an intercepted request', () => {
    expect(buildAbsoluteUrl(true, 'example.com', '/a/b?c=1')).toBe('https://example.com/a/b?c=1');
  });
  it('passes an already-absolute url through unchanged', () => {
    expect(buildAbsoluteUrl(false, 'ignored', 'http://h/p')).toBe('http://h/p');
  });
});

describe('guessResourceType', () => {
  it('maps Sec-Fetch-Dest values', () => {
    expect(guessResourceType({ 'sec-fetch-dest': 'script' }, 'https://x/y')).toBe('script');
    expect(guessResourceType({ 'sec-fetch-dest': 'image' }, 'https://x/y')).toBe('image');
    expect(guessResourceType({ 'sec-fetch-dest': 'document' }, 'https://x/y')).toBe('main_frame');
  });
  it('falls back to a file-extension heuristic', () => {
    expect(guessResourceType({}, 'https://x/app.js?v=1')).toBe('script');
    expect(guessResourceType({}, 'https://x/a.png')).toBe('image');
  });
  it('defaults to "other" when nothing matches', () => {
    expect(guessResourceType({}, 'https://x/api/data')).toBe('other');
  });
});

describe('parseDataUrl', () => {
  it('decodes a base64 data url', () => {
    const url = `data:application/javascript;base64,${Buffer.from('var x=1;').toString('base64')}`;
    const out = parseDataUrl(url);
    expect(out?.contentType).toBe('application/javascript');
    expect(out?.body.toString('utf8')).toBe('var x=1;');
  });
  it('decodes a percent-encoded plain data url', () => {
    const out = parseDataUrl('data:text/plain,hello%20world');
    expect(out?.body.toString('utf8')).toBe('hello world');
  });
  it('returns null for non-data urls', () => {
    expect(parseDataUrl('https://x/y')).toBeNull();
  });
});

describe('html injection', () => {
  it('injects the style right after <head>', () => {
    const html = '<html><head><title>t</title></head><body>x</body></html>';
    const out = injectIntoHtml(html, { styles: '.ad{display:none}', scripts: [] });
    expect(out).toContain('<style');
    expect(out.indexOf('<style')).toBeGreaterThan(out.indexOf('<head>'));
    expect(out.indexOf('<style')).toBeLessThan(out.indexOf('</head>'));
  });
  it('wraps scriptlets in <script> tags', () => {
    const out = injectIntoHtml('<head></head>', { styles: '', scripts: ['window.x=1'] });
    expect(out).toContain('<script');
    expect(out).toContain('window.x=1');
  });
  it('returns html unchanged when the payload is empty', () => {
    const html = '<head></head>';
    expect(injectIntoHtml(html, { styles: '   ', scripts: [] })).toBe(html);
  });
  it('finds a body anchor when there is no head, and -1 when there is no anchor', () => {
    expect(findInjectionOffset('<body>hi</body>')).toBeGreaterThanOrEqual(0);
    expect(findInjectionOffset('no tags here')).toBe(-1);
  });
});

describe('decompressBody', () => {
  const text = '<html><head></head><body>hi</body></html>';
  it('round-trips gzip', () => {
    expect(decompressBody(gzipSync(Buffer.from(text)), 'gzip').toString('utf8')).toBe(text);
  });
  it('round-trips brotli', () => {
    expect(decompressBody(brotliCompressSync(Buffer.from(text)), 'br').toString('utf8')).toBe(text);
  });
  it('passes identity through', () => {
    expect(decompressBody(Buffer.from(text), '').toString('utf8')).toBe(text);
  });
  it('reports which encodings it can handle', () => {
    expect(canDecompress('gzip')).toBe(true);
    expect(canDecompress('br')).toBe(true);
    expect(canDecompress('')).toBe(true);
    expect(canDecompress('zstd')).toBe(ZSTD_SUPPORTED);
    expect(canDecompress('xz')).toBe(false);
  });
});

describe('bypass matching', () => {
  it('strips the port, including bracketed IPv6', () => {
    expect(hostnameWithoutPort('example.com:443')).toBe('example.com');
    expect(hostnameWithoutPort('[::1]:8080')).toBe('::1');
  });
  it('matches a host and its subdomains', () => {
    expect(isBypassed('secure.chase.com', ['chase.com'])).toBe(true);
    expect(isBypassed('chase.com', ['chase.com'])).toBe(true);
    expect(isBypassed('notchase.com', ['chase.com'])).toBe(false);
  });
});

describe('stripTrackingParams', () => {
  it('strips utm_* params and reports changed', () => {
    const r = stripTrackingParams(
      'https://example.com/page?utm_source=email&utm_medium=cpc&utm_campaign=sale&q=hello',
    );
    expect(r.changed).toBe(true);
    const u = new URL(r.url);
    expect(u.searchParams.has('utm_source')).toBe(false);
    expect(u.searchParams.has('utm_medium')).toBe(false);
    expect(u.searchParams.has('utm_campaign')).toBe(false);
    expect(u.searchParams.get('q')).toBe('hello');
  });

  it('strips gclid, fbclid, and other ad-platform params', () => {
    const r = stripTrackingParams(
      'https://example.com/?gclid=abc&fbclid=xyz&msclkid=m&dclid=d&gbraid=g&wbraid=w',
    );
    expect(r.changed).toBe(true);
    const u = new URL(r.url);
    for (const p of ['gclid', 'fbclid', 'msclkid', 'dclid', 'gbraid', 'wbraid']) {
      expect(u.searchParams.has(p)).toBe(false);
    }
  });

  it('strips mc_eid, igshid, _hsenc, _hsmi, yclid, ttclid', () => {
    const r = stripTrackingParams(
      'https://example.com/?mc_eid=a&igshid=b&_hsenc=c&_hsmi=d&yclid=e&ttclid=f',
    );
    expect(r.changed).toBe(true);
    const u = new URL(r.url);
    for (const p of ['mc_eid', 'igshid', '_hsenc', '_hsmi', 'yclid', 'ttclid']) {
      expect(u.searchParams.has(p)).toBe(false);
    }
  });

  it('leaves non-tracking params untouched', () => {
    const url = 'https://example.com/search?q=cats&page=2';
    const r = stripTrackingParams(url);
    expect(r.changed).toBe(false);
    expect(r.url).toBe(url);
  });

  it('returns changed: false and the original url when there is no query string', () => {
    const url = 'https://example.com/page';
    const r = stripTrackingParams(url);
    expect(r.changed).toBe(false);
    expect(r.url).toBe(url);
  });

  it('handles a URL that is only tracking params (no surviving params)', () => {
    const r = stripTrackingParams('https://example.com/?utm_source=email');
    expect(r.changed).toBe(true);
    const u = new URL(r.url);
    expect(u.search).toBe('');
  });
});

describe('extractDomFeatures', () => {
  it('collects classes, ids and hrefs from double-quoted, single-quoted and bare attributes', () => {
    const html =
      '<div class="ad-slot sponsored" id="top-ad"><a href=\'/promo\'>x</a>' +
      '<span class=banner id=b2></span></div>';
    const f = extractDomFeatures(html);
    expect(f.classes).toEqual(['ad-slot', 'sponsored', 'banner']);
    expect(f.ids).toEqual(['top-ad', 'b2']);
    expect(f.hrefs).toEqual(['/promo']);
  });

  it('dedupes repeated values and skips empty attributes', () => {
    const f = extractDomFeatures('<p class="a"></p><p class="a b" id=""></p><p class=""></p>');
    expect(f.classes).toEqual(['a', 'b']);
    expect(f.ids).toEqual([]);
    expect(f.hrefs).toEqual([]);
  });
});

describe('stripZstdFromAcceptEncoding', () => {
  it('removes zstd and keeps the other encodings', () => {
    expect(stripZstdFromAcceptEncoding('gzip, deflate, br, zstd')).toBe('gzip, deflate, br');
  });
  it('matches case-insensitively and with q-values', () => {
    expect(stripZstdFromAcceptEncoding('ZSTD;q=1.0, gzip;q=0.8')).toBe('gzip;q=0.8');
  });
});

describe('zstd bodies', () => {
  it('decodes a zstd-encoded body when the runtime has a decoder', () => {
    if (!ZSTD_SUPPORTED) return; // older Node: covered by the Accept-Encoding rewrite instead
    expect(canDecompress('zstd')).toBe(true);
    const body = zstdCompressSync(Buffer.from('<html>zstd</html>'));
    expect(decompressBody(body, 'zstd').toString('utf8')).toBe('<html>zstd</html>');
  });
});

describe('injectIntoHtmlBytes', () => {
  it('splices the markup after <head> without transcoding the page bytes', () => {
    // 0xE9 is "é" in windows-1252; a utf8 round-trip would corrupt it.
    const page = Buffer.from('<html><head></head><body>caf\xe9</body></html>', 'latin1');
    const out = injectIntoHtmlBytes(page, { styles: '.x{display:none}', scripts: [] });
    expect(out.toString('latin1')).toBe(
      '<html><head><style type="text/css" id="ghetto-blocker-cosmetics">.x{display:none}</style></head><body>caf\xe9</body></html>',
    );
  });
  it('returns the same buffer when there is nothing to inject', () => {
    const page = Buffer.from('<html></html>');
    expect(injectIntoHtmlBytes(page, { styles: '', scripts: [] })).toBe(page);
  });
});

describe('scriptlet isolation (YouTube regression)', () => {
  /** Run every injected <script> body in one shared realm, like a browser does. */
  function runBlobScripts(blob: string, sandbox: Record<string, unknown>): void {
    const ctx = createContext(sandbox);
    for (const m of blob.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      runInContext(m[1] ?? '', ctx);
    }
  }

  it('lets two scriptlets that both declare the same helper class run in one page', () => {
    // Each uBO scriptlet ships its own `class JSONPath`; as plain top-level
    // scripts the second one is "Identifier 'JSONPath' has already been declared".
    const scripts = [
      'class JSONPath { static n() { return 1; } } results.push(JSONPath.n());',
      'class JSONPath { static n() { return 2; } } results.push(JSONPath.n());',
    ];
    const results: number[] = [];
    runBlobScripts(buildInjectionBlob({ styles: '', scripts }), { results });
    expect(results).toEqual([1, 2]);
  });

  it('keeps each scriptlet\'s helper functions out of the shared global scope', () => {
    // uBO's proxyApplyFn keeps state on the function object; a later scriptlet
    // must not see (or replace) an earlier scriptlet's copy.
    const scripts = [
      'function proxyApplyFn() {} proxyApplyFn.owner = "first"; seen.push(proxyApplyFn.owner);',
      'function proxyApplyFn() {} seen.push(proxyApplyFn.owner ?? "fresh");',
    ];
    const seen: string[] = [];
    const sandbox: Record<string, unknown> = { seen };
    runBlobScripts(buildInjectionBlob({ styles: '', scripts }), sandbox);
    expect(seen).toEqual(['first', 'fresh']);
    expect(sandbox['proxyApplyFn']).toBeUndefined();
  });

  it('does not let one throwing scriptlet stop the next one', () => {
    const scripts = ['throw new Error("boom");', 'ran.push(true);'];
    const ran: boolean[] = [];
    runBlobScripts(buildInjectionBlob({ styles: '', scripts }), { ran });
    expect(ran).toEqual([true]);
  });
});
