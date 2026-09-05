/* background.js -- ghetto-blocker MV3 service worker
 *
 * All cross-origin requests to the control server (127.0.0.1:8081) go through
 * here. Content scripts NEVER fetch the server directly -- Private Network
 * Access (PNA) requires the SW to do it (SW has host_permissions; content
 * scripts do not and would be blocked by the PNA preflight).
 *
 * Two clients:
 *   - popup.js      -> ping / appendRule / startPicker (element picker)
 *   - cosmetics.js  -> cosmetics (per-frame dynamic hide rules; the CSS is
 *                      applied here with chrome.scripting.insertCSS as a
 *                      user-origin stylesheet so page CSP cannot block it)
 *
 * CSRF note: every mutating fetch includes X-GhettoBlocker: 1.
 */

'use strict';

const CONTROL = 'http://127.0.0.1:8081';
const CSRF_HEADERS = { 'Content-Type': 'application/json', 'X-GhettoBlocker': '1' };

// ---- Control server calls ------------------------------------------------

async function ping() {
  try {
    const r = await fetch(`${CONTROL}/api/state`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function appendRule(rule) {
  const r = await fetch(`${CONTROL}/api/rules/append`, {
    method: 'POST',
    headers: CSRF_HEADERS,
    body: JSON.stringify({ rule }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
}

async function fetchCosmetics(request) {
  const r = await fetch(`${CONTROL}/api/cosmetics`, {
    method: 'POST',
    headers: CSRF_HEADERS,
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json();
}

/** Answer a content script's cosmetics request and apply the returned CSS to its frame. */
async function handleCosmetics(msg, sender) {
  const { active, styles, extended, adNauseam } = await fetchCosmetics({
    url: msg.url,
    lifecycle: msg.lifecycle,
    classes: msg.classes,
    ids: msg.ids,
    hrefs: msg.hrefs,
  });
  const tabId = sender.tab?.id;
  if (active && styles && tabId !== undefined) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId, frameIds: [sender.frameId ?? 0] },
        css: styles,
        origin: 'USER',
      });
    } catch {
      // Frame navigated away or was removed before the CSS could be applied.
    }
  }
  return { ok: true, active, extended, adNauseam: adNauseam === true };
}

// ---- Per-tab blocked counter -> icon badge --------------------------------
// The proxy answers every blocked request with `x-ghetto-blocker: block`;
// webRequest.onCompleted sees that header with the tab id, which is the only
// tab attribution a proxy-based blocker can get. Counts live in
// storage.session so they survive the service worker being suspended.

const tabBlocked = new Map();
let tabBlockedHydrated = false;

async function hydrateTabCounts() {
  if (tabBlockedHydrated) return;
  tabBlockedHydrated = true;
  try {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('tab:')) tabBlocked.set(Number(k.slice(4)), v);
    }
  } catch { /* storage.session unavailable */ }
}

function setTabCount(tabId, n) {
  tabBlocked.set(tabId, n);
  chrome.storage.session.set({ ['tab:' + tabId]: n }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n > 0 ? (n > 999 ? '999+' : String(n)) : '' }).catch(() => {});
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0 || details.type === 'main_frame') return;
    const marker = details.responseHeaders?.find(h => h.name.toLowerCase() === 'x-ghetto-blocker');
    if (!marker) return;
    hydrateTabCounts().then(() => setTabCount(details.tabId, (tabBlocked.get(details.tabId) ?? 0) + 1));
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders'],
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') setTabCount(tabId, 0); // new page in this tab
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabBlocked.delete(tabId);
  chrome.storage.session.remove('tab:' + tabId).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#0a0d14' }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: '#00f0ff' }).catch(() => {});
});

// ---- Per-site controls (popup) --------------------------------------------

async function getState() {
  const r = await fetch(`${CONTROL}/api/state`, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function postJson(path, body, method = 'POST') {
  const r = await fetch(`${CONTROL}${path}`, {
    method,
    headers: CSRF_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  return r.json();
}

/** Everything the popup shows for one tab. */
async function tabInfo(tabId, host) {
  await hydrateTabCounts();
  const state = await getState();
  const suffixMatch = (h) => host === h || host.endsWith('.' + h);
  return {
    ok: true,
    blocked: tabBlocked.get(tabId) ?? 0,
    paused: state.settings.paused,
    allowed: state.settings.allowlist.some(suffixMatch),
    adNauseam: state.settings.adNauseam === true,
  };
}

// ---- AdNauseam click scheduler -------------------------------------------
// Content scripts report ad click-through links; we announce each one to the
// control server (so the proxy lets it through untouched and records it),
// then fetch it after a random delay. Opaque no-cors fetch: the ad network
// counts the click on its first hop, we never look at the response.

const CLICK_MIN_DELAY_MS = 2_000;
const CLICK_MAX_DELAY_MS = 20_000;
const CLICK_MAX_PER_MINUTE = 8;
const CLICK_SEEN_CAP = 2_000;

const seenAds = new Set();
let clickQueue = [];
let clickTimer = null;
let clickTimestamps = [];
let queueHydrated = false;

// The queue survives the service worker being suspended mid-delay: it is
// mirrored into storage.session and a 30 s alarm re-arms the scheduler.
async function hydrateQueue() {
  if (queueHydrated) return;
  queueHydrated = true;
  try {
    const { clickQueue: saved } = await chrome.storage.session.get('clickQueue');
    if (Array.isArray(saved) && clickQueue.length === 0) clickQueue = saved;
  } catch { /* unavailable */ }
}
function persistQueue() {
  chrome.storage.session.set({ clickQueue }).catch(() => {});
}
chrome.alarms.create('adn-drain', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'adn-drain') hydrateQueue().then(scheduleClicks);
});

function scheduleClicks() {
  if (clickTimer !== null || clickQueue.length === 0) return;
  const delay = CLICK_MIN_DELAY_MS + Math.random() * (CLICK_MAX_DELAY_MS - CLICK_MIN_DELAY_MS);
  clickTimer = setTimeout(async () => {
    clickTimer = null;
    const now = Date.now();
    clickTimestamps = clickTimestamps.filter((t) => now - t < 60_000);
    if (clickTimestamps.length >= CLICK_MAX_PER_MINUTE) {
      scheduleClicks();
      return;
    }
    const job = clickQueue.shift();
    persistQueue();
    if (job) {
      clickTimestamps.push(now);
      await clickAd(job.url, job.page, job.image, job.title);
    }
    scheduleClicks();
  }, delay);
}

async function clickAd(url, page, image, title) {
  try {
    await postJson('/api/adnauseam/click', { url, page, image, title });
  } catch (err) {
    // Mode switched off (409) or server gone: drop the click.
    return;
  }
  try {
    await fetch(url, {
      mode: 'no-cors',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Opaque cross-origin fetches reject freely; the request still went out.
  }
}

async function enqueueAds(ads, page) {
  await hydrateQueue();
  for (const ad of ads) {
    const url = typeof ad === 'string' ? ad : ad?.url;
    if (typeof url !== 'string' || seenAds.has(url)) continue;
    if (seenAds.size >= CLICK_SEEN_CAP) seenAds.clear();
    seenAds.add(url);
    clickQueue.push({ url, page, image: ad?.image, title: ad?.title });
  }
  persistQueue();
  scheduleClicks();
}

// ---- Content-script injection -------------------------------------------

async function injectAndActivate(tabId, mode) {
  // Inject selector heuristic first, then the picker overlay.
  // If already injected, the guard in content.js is a no-op; the
  // subsequent activate message still reaches the existing listener.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['selector.js', 'content.js'],
  });
  // Scripts are fully evaluated at this point -- send the activation.
  await chrome.tabs.sendMessage(tabId, { type: 'activate', mode });
}

// ---- Message handler ----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'cosmetics') {
    handleCosmetics(msg, sender)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'adsFound') {
    enqueueAds(msg.ads ?? msg.urls ?? [], sender.tab?.url ?? sender.url ?? '').then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'ping') {
    ping().then(ok => sendResponse({ ok }));
    return true; // async response
  }

  if (msg.type === 'tabInfo') {
    tabInfo(msg.tabId, msg.host)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'setAllow') {
    postJson('/api/allowlist', { host: msg.host }, msg.on ? 'POST' : 'DELETE')
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'setPaused') {
    postJson('/api/settings', { paused: !!msg.on })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'appendRule') {
    appendRule(msg.rule)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'startPicker') {
    const { tabId, mode } = msg;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tab id' });
      return false;
    }
    injectAndActivate(tabId, mode)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
