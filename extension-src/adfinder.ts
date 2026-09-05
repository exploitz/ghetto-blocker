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

/**
 * Collect ad click-through URLs under `roots`. In an ad-network frame every
 * outbound http(s) link counts; elsewhere only recognised click trackers do.
 */
export function findAdLinks(roots: Element[], adFrame: boolean, ownHost: string): string[] {
  const found = new Set<string>();
  for (const root of roots) {
    const anchors: Element[] = [];
    if (root.matches?.('a[href]')) anchors.push(root);
    anchors.push(...root.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const href = (a as HTMLAnchorElement).href;
      if (!href || !/^https?:/i.test(href)) continue;
      if (isClickUrl(href)) {
        found.add(href);
        continue;
      }
      if (adFrame) {
        try {
          if (new URL(href).hostname !== ownHost) found.add(href);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return [...found];
}
