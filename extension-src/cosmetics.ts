/**
 * cosmetics.ts -- dynamic cosmetic filtering content script.
 *
 * Bundled by esbuild into extension/cosmetics.js and run at document_start in
 * every http(s) frame. The proxy already injected the generic base stylesheet,
 * the hostname rules and the scriptlets into the HTML; this script covers what
 * the proxy cannot see:
 *
 *   1. Elements created by JavaScript after the HTML was served (ad slots,
 *      lazy-loaded placeholders, SPA views). A DOMMonitor reports every new
 *      class/id/href to the control server, which answers with the generic
 *      hide rules indexed by those features. The service worker applies the
 *      CSS as a user-origin stylesheet.
 *   2. Procedural ("extended") rules such as `:has-text()` / `:upward()` that
 *      plain CSS cannot express. They are evaluated here against every DOM
 *      update.
 *
 * The control server is reached exclusively through the service worker (a
 * content script has no host permission for 127.0.0.1 and would be blocked).
 */

import { DOMMonitor } from '@ghostery/adblocker-content';
import type { DOMUpdate } from '@ghostery/adblocker-content';
import { handlePseudoDirective, matches, querySelectorAll } from '@ghostery/adblocker-extended-selectors';
import type { AST } from '@ghostery/adblocker-extended-selectors';
import { findAds, isAdFrame } from './adfinder.js';
import type { AdInfo } from './adfinder.js';

interface ExtendedRule {
  id: number;
  ast: AST;
  attribute?: string | undefined;
  directive?: AST | undefined;
}

interface CosmeticsReply {
  ok: boolean;
  active?: boolean;
  adNauseam?: boolean;
  extended?: ExtendedRule[];
  error?: string;
}

interface AdsFoundMessage {
  type: 'adsFound';
  ads: AdInfo[];
}

interface CosmeticsMessage {
  type: 'cosmetics';
  lifecycle: 'start' | 'dom-update';
  url: string;
  classes: string[];
  ids: string[];
  hrefs: string[];
}

declare global {
  interface Window {
    __ghCosmeticsInstalled?: boolean;
  }
}

(function main(): void {
  const { protocol, hostname } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return;
  // Never touch the dashboard itself.
  if (hostname === '127.0.0.1' || hostname === 'localhost') return;
  if (window.__ghCosmeticsInstalled) return;
  window.__ghCosmeticsInstalled = true;

  const extended: ExtendedRule[] = [];
  const knownExtended = new Set<number>();

  // AdNauseam: ad links reported so far (the service worker dedupes across frames too).
  let huntAds = false;
  const reportedAds = new Set<string>();
  const adFrame = isAdFrame(window);

  function reportAds(roots: Element[]): void {
    if (!huntAds) return;
    const fresh = findAds(roots, adFrame, window.location.hostname).filter((ad) => !reportedAds.has(ad.url));
    if (fresh.length === 0) return;
    for (const ad of fresh) reportedAds.add(ad.url);
    const message: AdsFoundMessage = { type: 'adsFound', ads: fresh };
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      /* extension context gone */
    }
  }

  function send(message: CosmeticsMessage): Promise<CosmeticsReply> {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response: unknown) => {
          if (chrome.runtime.lastError || !response) {
            resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'no response' });
          } else {
            resolve(response as CosmeticsReply);
          }
        });
      } catch (err) {
        // Extension context invalidated (reloaded/disabled) -- stop quietly.
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /** Register new procedural rules; returns true if any were new. */
  function addExtended(rules: ExtendedRule[] | undefined): boolean {
    let added = false;
    for (const rule of rules ?? []) {
      if (knownExtended.has(rule.id)) continue;
      knownExtended.add(rule.id);
      extended.push(rule);
      added = true;
    }
    return added;
  }

  function applyRule(rule: ExtendedRule, el: Element): void {
    if (rule.directive) {
      // `:remove()`, `:style()` ... -- the library performs the side effect.
      handlePseudoDirective(el, rule.directive);
    } else if (rule.attribute) {
      // The server-side stylesheet carries `[<attribute>] { display: none !important }`.
      el.setAttribute(rule.attribute, '');
    } else {
      (el as HTMLElement).style.setProperty('display', 'none', 'important');
    }
  }

  /** Evaluate every known procedural rule against the given roots (and their subtrees). */
  function applyExtended(roots: Element[]): void {
    if (extended.length === 0 || roots.length === 0) return;
    for (const rule of extended) {
      for (const root of roots) {
        try {
          if (matches(root, rule.ast)) applyRule(rule, root);
          for (const el of querySelectorAll(root, rule.ast)) applyRule(rule, el);
        } catch {
          // A malformed AST or a detached node must never break the page.
        }
      }
    }
  }

  const monitor = new DOMMonitor((update: DOMUpdate) => {
    if (update.type === 'elements') {
      applyExtended(update.elements);
      reportAds(update.elements);
      return;
    }
    void send({
      type: 'cosmetics',
      lifecycle: 'dom-update',
      url: window.location.href,
      classes: update.classes,
      ids: update.ids,
      hrefs: update.hrefs,
    }).then((reply) => {
      if (reply.ok && reply.active && addExtended(reply.extended)) {
        applyExtended([document.documentElement]);
      }
    });
  });

  void send({
    type: 'cosmetics',
    lifecycle: 'start',
    url: window.location.href,
    classes: [],
    ids: [],
    hrefs: [],
  }).then((reply) => {
    if (!reply.ok || !reply.active) return; // server down, paused, or site allowlisted
    addExtended(reply.extended);
    huntAds = reply.adNauseam === true;
    monitor.start(window);
    const scan = (): void => monitor.queryAll(window);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scan, { once: true });
    } else {
      scan();
    }
    window.addEventListener('load', scan, { once: true });
  });
})();

export {};
