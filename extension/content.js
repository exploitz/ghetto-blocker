/* content.js -- ghetto-blocker element picker / zapper overlay
 *
 * Injected on demand by background.js when the user clicks Pick or Zap in
 * the popup. Communicates back to the SW via chrome.runtime.sendMessage --
 * never fetches the control server directly (PNA safety).
 *
 * Modes:
 *   pick  -- highlight on hover, click to preview selector, confirm to persist
 *   zap   -- highlight on hover, click to hide immediately (no persist)
 *
 * ESC cancels at any time.
 */

/* exported to content-script global scope by selector.js (injected first) */
/* global uniqueSelector */

(function () {
  'use strict';

  // ---- Idempotency guard -------------------------------------------------
  // Chrome may re-inject these files if the user clicks Pick multiple times.
  // The guard prevents duplicate listener setup; the existing listener will
  // still receive the 'activate' message from background.js after re-injection.
  if (window.__ghBlockerInstalled) return;
  window.__ghBlockerInstalled = true;

  // ---- State -------------------------------------------------------------
  let mode = null;         // 'pick' | 'zap' | null
  let hovered = null;      // currently highlighted element
  let dialogEl = null;     // confirm dialog (pick mode only)

  // ---- Styles ------------------------------------------------------------
  const STYLE_ID = '__gh_styles';
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .__gh_hl {
        outline: 2px solid #00ff41 !important;
        outline-offset: 1px !important;
        cursor: crosshair !important;
      }
      .__gh_dialog {
        all: initial;
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483647;
        background: #080808;
        border: 1px solid #00ff41;
        color: #c8c8c8;
        font: 13px/1.5 "Courier New",monospace;
        padding: 14px 18px;
        border-radius: 4px;
        box-shadow: 0 0 14px rgba(0,255,65,0.25);
        max-width: 380px;
        word-break: break-all;
      }
      .__gh_dialog b { color: #fff; }
      .__gh_dialog code {
        display: block;
        color: #00ff41;
        font-family: "Courier New",monospace;
        font-size: 12px;
        margin: 6px 0 2px;
      }
      .__gh_matches {
        display: block;
        font-size: 11px;
        color: #666;
        margin-bottom: 10px;
      }
      .__gh_btns { display: flex; gap: 8px; margin-top: 10px; }
      .__gh_btn {
        all: initial;
        background: #111;
        border: 1px solid #00ff41;
        color: #00ff41;
        font: 12px "Courier New",monospace;
        padding: 5px 12px;
        cursor: pointer;
        border-radius: 3px;
        transition: background 0.1s;
      }
      .__gh_btn:hover { background: #00ff41; color: #080808; }
      .__gh_btn_cancel { border-color: #555; color: #888; }
      .__gh_btn_cancel:hover { background: #555; color: #fff; }
      .__gh_toast {
        all: initial;
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: #080808;
        border: 1px solid #00ff41;
        color: #00ff41;
        font: 12px "Courier New",monospace;
        padding: 8px 20px;
        border-radius: 4px;
        box-shadow: 0 0 10px rgba(0,255,65,0.2);
        white-space: nowrap;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- Helpers -----------------------------------------------------------

  function toast(msg, color) {
    const t = document.createElement('div');
    t.className = '__gh_toast';
    if (color) t.style.cssText = `border-color:${color};color:${color}`;
    t.textContent = msg;
    (document.body || document.documentElement).appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function clearHighlight() {
    if (hovered) {
      hovered.classList.remove('__gh_hl');
      hovered = null;
    }
  }

  function clearDialog() {
    if (dialogEl) { dialogEl.remove(); dialogEl = null; }
  }

  function deactivate() {
    mode = null;
    clearHighlight();
    clearDialog();
    document.removeEventListener('mousemove', onMousemove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
  }

  // ---- Event handlers ----------------------------------------------------

  function onMousemove(e) {
    const el = e.target;
    if (!el || el === hovered) return;
    // Don't highlight our own dialog
    if (dialogEl && (el === dialogEl || dialogEl.contains(el))) return;
    clearHighlight();
    if (el !== document.body && el !== document.documentElement) {
      el.classList.add('__gh_hl');
      hovered = el;
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      deactivate();
    }
  }

  function onClick(e) {
    // Pass through clicks on our own dialog to its button handlers
    if (dialogEl && (e.target === dialogEl || dialogEl.contains(e.target))) return;

    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    if (!el || el === document.documentElement) return;

    const sel = (typeof uniqueSelector === 'function')
      ? uniqueSelector(el)
      : el.tagName.toLowerCase();

    if (mode === 'zap') {
      // Local hide only -- no persist, no SW call
      el.style.display = 'none';
      toast('Zapped (this page only)');
      deactivate();
      return;
    }

    // pick mode: show confirm dialog
    clearDialog();

    const host = window.location.hostname;
    const rule = `${host}##${sel}`;
    let matches = 0;
    try { matches = document.querySelectorAll(sel).length; } catch { matches = 1; }

    const d = document.createElement('div');
    d.className = '__gh_dialog';
    d.innerHTML = [
      '<div>Block on <b></b>?</div>',
      '<code></code>',
      '<span class="__gh_matches"></span>',
      '<div class="__gh_btns">',
      '  <button class="__gh_btn" id="__gh_confirm">Save rule</button>',
      '  <button class="__gh_btn __gh_btn_cancel" id="__gh_cancel">Cancel</button>',
      '</div>',
    ].join('');
    // Set text content safely (no innerHTML injection from page data)
    d.querySelector('b').textContent = host;
    d.querySelector('code').textContent = rule;
    d.querySelector('.__gh_matches').textContent =
      `${matches} matching element${matches !== 1 ? 's' : ''} on this page`;

    d.querySelector('#__gh_confirm').addEventListener('click', () => {
      deactivate();
      chrome.runtime.sendMessage({ type: 'appendRule', rule }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          toast('Error: ' + (resp?.error ?? chrome.runtime.lastError?.message ?? 'unknown'), '#ff4444');
        } else {
          toast('Rule saved!');
        }
      });
    });

    d.querySelector('#__gh_cancel').addEventListener('click', () => deactivate());

    (document.body || document.documentElement).appendChild(d);
    dialogEl = d;
  }

  // ---- Activation --------------------------------------------------------

  function activate(pickerMode) {
    if (mode) deactivate(); // cancel any in-progress mode first
    mode = pickerMode;
    document.addEventListener('mousemove', onMousemove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    const hint = (pickerMode === 'zap')
      ? 'Click an element to zap it (ESC to cancel)'
      : 'Click an element to block it (ESC to cancel)';
    toast(hint);
  }

  // ---- Listen for SW messages -------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'activate') {
      activate(msg.mode);
      sendResponse({ ok: true });
    }
  });
})();
