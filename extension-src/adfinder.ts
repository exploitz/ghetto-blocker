/**
 * adfinder.ts -- find the click-through links of ads on a page (AdNauseam mode).
 *
 * Two signals, both conservative so ordinary page links are never touched:
 *   1. The link itself is an ad-network click tracker (`adclick.g.doubleclick.net`,
 *      `googleadservices.com/pagead/aclk`, Taboola/Outbrain redirects, ...).
 *   2. The frame we run in is served by an ad network (Google ads render inside
 *      googlesyndication/doubleclick iframes): then every outbound link in it is
 *      the ad's destination.
 */

const CLICK_URL_RE = new RegExp(
  [
    'adclick\\.g\\.doubleclick\\.net',
    'googleadservices\\.com/pagead/aclk',
    '/pagead/aclk\\?',
    'ad\\.doubleclick\\.net/(?:ddm/)?(?:clk|trackclk)',
    'bing\\.com/aclick',
    'taboola\\.com/redirect',
    'outbrain\\.com/network/redir',
    'adnxs\\.com/click',
    'criteo\\.(?:com|net)/delivery/ck',
    'amazon-adsystem\\.com/x/c/',
    'adsrvr\\.org/click',
    'adform\\.net/C/',
    'flashtalking\\.com/click',
    'atdmt\\.com/c/',
    'mediaplex\\.com/ad/ck',
    'dartsearch\\.net/link/click',
    'clickserve\\.',
    'smartadserver\\.com/click',
    'yieldmo\\.com/click',
    'sharethrough\\.com/click',
    'media\\.net/click',
    'zedo\\.com/.*clk',
    '/adclick\\?',
  ].join('|'),
  'i',
);

const AD_FRAME_HOST_RE =
  /(^|\.)(googlesyndication\.com|doubleclick\.net|2mdn\.net|adnxs\.com|amazon-adsystem\.com|criteo\.(?:com|net)|taboola\.com|outbrain\.com|media\.net|pubmatic\.com|rubiconproject\.com|openx\.net|yieldmo\.com|sharethrough\.com|adroll\.com|adsrvr\.org|adform\.net|smartadserver\.com|teads\.tv|33across\.com|indexww\.com|casalemedia\.com|advertising\.com|adsafeprotected\.com|servedbyadbutler\.com|adbutler\.com)$/i;

/** True when this frame is itself served by an ad network. */
export function isAdFrame(win: Window): boolean {
  try {
    return win !== win.top && AD_FRAME_HOST_RE.test(win.location.hostname);
  } catch {
    return false;
  }
}

/** True when `href` is a known ad click-through URL. */
export function isClickUrl(href: string): boolean {
  return CLICK_URL_RE.test(href);
}

/** What we know about one ad: where a click goes, and what it looked like. */
export interface AdInfo {
  url: string;
  /** Creative image URL, when the ad has one. */
  image?: string;
  /** Alt text, title or link text -- whatever the ad used as copy. */
  title?: string;
}

function largestImage(scope: ParentNode): HTMLImageElement | null {
  let best: HTMLImageElement | null = null;
  let bestArea = 0;
  for (const img of scope.querySelectorAll('img')) {
    const src = img.currentSrc || img.src;
    if (!src || !/^https?:/i.test(src)) continue;
    const area = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
    if (area > bestArea || best === null) {
      best = img;
      bestArea = area;
    }
  }
  return best;
}

function describe(a: HTMLAnchorElement, adFrame: boolean): AdInfo {
  const info: AdInfo = { url: a.href };
  // The creative: an image inside the link, else (inside an ad frame) the
  // frame's biggest image -- Google ads often put the link over the creative.
  const img = largestImage(a) ?? (adFrame ? largestImage(document) : null);
  if (img) {
    info.image = (img.currentSrc || img.src).slice(0, 2048);
    const alt = img.alt?.trim();
    if (alt) info.title = alt.slice(0, 120);
  }
  if (!info.title) {
    const text = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) info.title = text.slice(0, 120);
  }
  return info;
}

/**
 * Collect the ads under `roots`. In an ad-network frame every outbound http(s)
 * link counts; elsewhere only recognised click trackers do.
 */
export function findAds(roots: Element[], adFrame: boolean, ownHost: string): AdInfo[] {
  const found = new Map<string, AdInfo>();
  for (const root of roots) {
    const anchors: Element[] = [];
    if (root.matches?.('a[href]')) anchors.push(root);
    anchors.push(...root.querySelectorAll('a[href]'));
    for (const el of anchors) {
      const a = el as HTMLAnchorElement;
      const href = a.href;
      if (!href || !/^https?:/i.test(href) || found.has(href)) continue;
      let isAd = isClickUrl(href);
      if (!isAd && adFrame) {
        try {
          isAd = new URL(href).hostname !== ownHost;
        } catch {
          isAd = false;
        }
      }
      if (isAd) found.set(href, describe(a, adFrame));
    }
  }
  return [...found.values()];
}

/** URLs only -- kept for callers that don't need the creative. */
export function findAdLinks(roots: Element[], adFrame: boolean, ownHost: string): string[] {
  return findAds(roots, adFrame, ownHost).map((ad) => ad.url);
}
