/* popup.js -- ghetto-blocker extension popup
 *
 * Shows the blocked count for the active tab (kept by the service worker
 * from the proxy's x-ghetto-blocker markers), lets you allow/unallow the
 * current site, pause/resume everything, and start the element picker.
 */

'use strict';

const $ = (id) => document.getElementById(id);
let tab = null;
let host = '';
let info = null;

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError || !resp) resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'no response' });
      else resolve(resp);
    });
  });
}

function say(text, isError) {
  const el = $('msg');
  el.textContent = text;
  el.className = isError ? 'err' : '';
  el.style.display = text ? 'block' : 'none';
}

function render() {
  const online = !!(info && info.ok);
  $('statusDot').className = 'dot ' + (online ? 'online' : 'offline');
  $('statusText').textContent = online ? 'connected' : 'offline';
  $('pageHost').textContent = host || '(no site)';
  $('blockedCount').textContent = online ? String(info.blocked) : '–';

  const allowed = online && info.allowed;
  const paused = online && info.paused;
  $('site').classList.toggle('allowed', allowed);
  $('siteState').textContent = paused ? 'blocking paused' : allowed ? 'site allowed (not filtered)' : '';

  const btnAllow = $('btnAllow');
  btnAllow.textContent = allowed ? 'Stop allowing this site' : 'Allow this site';
  btnAllow.classList.toggle('on', allowed);
  btnAllow.disabled = !online || !host;

  const btnPause = $('btnPause');
  btnPause.textContent = paused ? 'Resume blocking' : 'Pause blocking';
  btnPause.classList.toggle('on', paused);
  btnPause.disabled = !online;
}

async function refresh() {
  info = tab ? await send({ type: 'tabInfo', tabId: tab.id, host }) : { ok: false };
  render();
}

// ---- Actions ---------------------------------------------------------------

$('btnAllow').addEventListener('click', async () => {
  const r = await send({ type: 'setAllow', host, on: !info.allowed });
  if (!r.ok) { say('Error: ' + r.error, true); return; }
  await refresh();
  say(info.allowed ? 'Reload the page to see it unfiltered.' : 'Reload the page to filter it again.');
});

$('btnPause').addEventListener('click', async () => {
  const r = await send({ type: 'setPaused', on: !info.paused });
  if (!r.ok) { say('Error: ' + r.error, true); return; }
  await refresh();
});

function startPicker(mode) {
  if (!tab?.id) { say('Could not get active tab.', true); return; }
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://') || tab.url?.startsWith('vivaldi://')) {
    say('Cannot inject into browser pages.', true);
    return;
  }
  chrome.runtime.sendMessage({ type: 'startPicker', mode, tabId: tab.id }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      say(resp?.error ?? chrome.runtime.lastError?.message ?? 'Injection failed.', true);
      return;
    }
    window.close();
  });
}

$('btnPick').addEventListener('click', () => startPicker('pick'));
$('btnZap').addEventListener('click', () => startPicker('zap'));
$('btnDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:8081' });
  window.close();
});

// ---- Init ------------------------------------------------------------------

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  tab = tabs?.[0] ?? null;
  try { host = new URL(tab?.url ?? '').hostname; } catch { host = ''; }
  refresh();
});
