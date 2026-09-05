/* app.js -- ghetto-blocker dashboard client (vanilla JS, no build step) */
'use strict';

// All mutating fetches must include X-GhettoBlocker: 1 (CSRF guard).
const H_JSON = { 'Content-Type': 'application/json', 'X-GhettoBlocker': '1' };

async function api(method, path, body) {
  const opts = { method, headers: H_JSON };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(String(err.error || r.status));
  }
  return r.json();
}

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

let notifyTimer = null;
function notify(msg) {
  const el = $('notification');
  el.textContent = msg;
  el.classList.add('visible');
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => el.classList.remove('visible'), 2500);
}

// ---------------------------------------------------------------------------
// Views (rail navigation)
// ---------------------------------------------------------------------------

function showView(name) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'sites') loadSites();
  if (name === 'vault') loadVault();
  if (name === 'overview') { loadLeaderboard(); drawGraph(); }
}

function initViews() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function updateCounters(totals) {
  $('cntBlocked').textContent = fmt(totals.blocked);
  $('cntHidden').textContent = fmt(totals.injected);
  $('cntPoisoned').textContent = fmt(totals.poisoned);
  $('cntAllowed').textContent = fmt(totals.allowed);
  $('cntClicked').textContent = fmt(totals.clicked);
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}

function applyState(state) {
  updateCounters(state.totals);
  if (state.since) {
    $('sinceLine').textContent = 'all-time totals since ' + new Date(state.since).toLocaleDateString();
  }
  if (state.lists) {
    $('listsAge').textContent = 'updated ' + ago(state.lists.builtAt);
  }
  if (state.update) applyUpdateStatus(state.version, state.update);
}

let updatePollTimer = null;
function applyUpdateStatus(version, u) {
  const line = $('versionLine');
  const btn = $('btnUpdate');
  const text = {
    unavailable: 'v' + version + (u.message ? ' · ' + u.message : ''),
    idle: 'v' + version,
    checking: 'v' + version + ' · checking…',
    downloading: 'v' + version + ' · downloading ' + (u.version || '') + (u.message ? ' ' + u.message : ''),
    ready: 'v' + version + ' → ' + u.version + ' ready',
    'up-to-date': 'v' + version + ' · up to date',
    error: 'v' + version + ' · update error: ' + (u.message || 'unknown'),
  }[u.state] || 'v' + version;
  line.textContent = text;
  line.title = u.message || '';
  btn.hidden = u.state === 'unavailable';
  btn.textContent = u.state === 'ready' ? 'Restart to update' : 'Check for updates';
  btn.disabled = u.state === 'checking' || u.state === 'downloading';
  btn.dataset.action = u.state === 'ready' ? 'install' : 'check';
  // While a check/download is in flight, keep the line fresh.
  const busy = u.state === 'checking' || u.state === 'downloading';
  if (busy && !updatePollTimer) updatePollTimer = setTimeout(() => { updatePollTimer = null; refreshCounters(); }, 1500);
}

function initUpdates() {
  $('btnUpdate').addEventListener('click', async () => {
    const action = $('btnUpdate').dataset.action;
    try {
      if (action === 'install') {
        await api('POST', '/api/update/install');
        notify('Restarting to install the update…');
      } else {
        const { update } = await api('POST', '/api/update/check');
        applyUpdateStatus($('versionLine').textContent.replace(/^v([^\s]+).*/, '$1'), update);
        notify(update.state === 'up-to-date' ? 'You are on the latest version' : update.state === 'error' ? 'Update check failed: ' + update.message : 'Checking…');
      }
    } catch (e) { notify('Error: ' + e.message); }
  });
}

async function refreshCounters() {
  try {
    applyState(await api('GET', '/api/state'));
  } catch (_) { /* ignore */ }
}

function initLists() {
  const btn = $('btnUpdateLists');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      const { builtAt } = await api('POST', '/api/lists/update');
      $('listsAge').textContent = 'updated ' + ago(builtAt);
      notify('Filter lists updated');
    } catch (e) { notify('Error: ' + e.message); }
    btn.disabled = false;
    btn.textContent = 'Update lists';
  });
}

// ---------------------------------------------------------------------------
// Settings / master controls
// ---------------------------------------------------------------------------

function applySettings(settings) {
  const btn = $('btnPause');
  const badge = $('statusBadge');
  btn.textContent = settings.paused ? 'Resume' : 'Pause';
  btn.classList.toggle('paused', settings.paused);
  badge.textContent = settings.paused ? 'PAUSED' : 'ACTIVE';
  badge.classList.toggle('paused', settings.paused);

  $('chkCosmetics').checked = settings.injectCosmetics;
  $('chkAntiAnalytics').checked = settings.antiAnalytics;
  $('chkStripCSP').checked = settings.stripCSP;
  $('chkAutostart').checked = settings.autostart;
  $('chkAdNauseam').checked = settings.adNauseam;
  $('vaultHint').hidden = settings.adNauseam;

  document.documentElement.setAttribute('data-theme', settings.theme);
  $('themeSelect').value = settings.theme;
}

function initControls() {
  $('btnPause').addEventListener('click', async () => {
    try {
      const state = await api('GET', '/api/state');
      const next = !state.settings.paused;
      const { settings } = await api('POST', '/api/settings', { paused: next });
      applySettings(settings);
      notify(next ? 'Filtering paused' : 'Filtering resumed');
    } catch (e) { notify('Error: ' + e.message); }
  });

  const makeToggle = (id, field, label) => {
    $(id).addEventListener('change', async (ev) => {
      try {
        const { settings } = await api('POST', '/api/settings', { [field]: ev.target.checked });
        applySettings(settings);
        notify(label + ' ' + (ev.target.checked ? 'on' : 'off'));
      } catch (e) {
        ev.target.checked = !ev.target.checked; // revert
        notify('Error: ' + e.message);
      }
    });
  };
  makeToggle('chkCosmetics', 'injectCosmetics', 'Cosmetics');
  makeToggle('chkAntiAnalytics', 'antiAnalytics', 'Anti-tracking');
  makeToggle('chkStripCSP', 'stripCSP', 'Strip CSP');
  makeToggle('chkAutostart', 'autostart', 'Start at login');
  makeToggle('chkAdNauseam', 'adNauseam', 'AdNauseam');

  const themeSelect = $('themeSelect');
  themeSelect.addEventListener('change', async () => {
    const theme = themeSelect.value;
    document.documentElement.setAttribute('data-theme', theme);
    try {
      await api('POST', '/api/settings', { theme });
      notify('Theme: ' + theme);
      drawGraph(); // colours come from the theme
    } catch (e) { notify('Error: ' + e.message); }
  });

  $('btnBypassSite').addEventListener('click', async () => {
    const host = $('bypassSiteInput').value.trim();
    if (!host) return;
    try {
      await api('POST', '/api/bypass', { host });
      $('bypassSiteInput').value = '';
      notify('Bypass added: ' + host);
    } catch (e) { notify('Error: ' + e.message); }
  });

  $('btnReport').addEventListener('click', async () => {
    const host = $('brokenHost').value.trim();
    const comment = $('brokenComment').value.trim();
    if (!host) { notify('Enter a hostname'); return; }
    try {
      await api('POST', '/api/broken-report', { host, comment });
      $('brokenHost').value = '';
      $('brokenComment').value = '';
      notify('Report saved for ' + host);
    } catch (e) { notify('Error: ' + e.message); }
  });
}

// ---------------------------------------------------------------------------
// Live feed (SSE) + activity graph
// ---------------------------------------------------------------------------

const MAX_FEED_ITEMS = 300;
const GRAPH_SECONDS = 60;

/** One bucket per second for the last GRAPH_SECONDS; index 0 = now. */
const buckets = Array.from({ length: GRAPH_SECONDS }, () => ({ block: 0, hide: 0, poison: 0 }));

function timeLabel(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

function appendFeedItem(ev) {
  const feed = $('activityFeed');
  const item = document.createElement('div');
  item.className = 'feed-item';
  item.dataset.type = ev.type;
  const typeEl = document.createElement('span');
  typeEl.className = 'type ' + ev.type;
  typeEl.textContent = { block: 'BLOCK', hide: 'CLEAN', poison: 'STRIP', allow: 'ALLOW', click: 'CLICK' }[ev.type] || ev.type.toUpperCase();
  const hostEl = document.createElement('span');
  hostEl.className = 'host';
  hostEl.textContent = ev.host;
  hostEl.title = ev.url || ev.host;
  const timeEl = document.createElement('span');
  timeEl.className = 'time';
  timeEl.textContent = timeLabel(ev.ts || Date.now());
  item.append(typeEl, hostEl, timeEl);
  feed.querySelector('.feed-empty')?.remove();
  feed.prepend(item);
  while (feed.children.length > MAX_FEED_ITEMS) feed.removeChild(feed.lastChild);
}

function initFeedChips() {
  $('feedChips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#feedChips .chip').forEach(c => c.classList.toggle('active', c === chip));
    $('activityFeed').dataset.filter = chip.dataset.filter;
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawGraph() {
  const canvas = $('activityGraph');
  if (!canvas || !canvas.isConnected) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 72;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const colors = { block: cssVar('--danger'), hide: cssVar('--accent2'), poison: cssVar('--warn') };
  const peak = Math.max(1, ...buckets.map(b => b.block + b.hide + b.poison));
  const gap = 2;
  const barW = Math.max(2, (w - gap * (GRAPH_SECONDS - 1)) / GRAPH_SECONDS);

  // Baseline
  ctx.fillStyle = cssVar('--border');
  ctx.fillRect(0, h - 1, w, 1);

  for (let i = 0; i < GRAPH_SECONDS; i++) {
    const b = buckets[GRAPH_SECONDS - 1 - i]; // oldest on the left
    const x = i * (barW + gap);
    let y = h - 1;
    for (const key of ['block', 'hide', 'poison']) {
      if (!b[key]) continue;
      const bh = Math.max(2, (b[key] / peak) * (h - 6));
      y -= bh;
      ctx.fillStyle = colors[key];
      ctx.fillRect(x, y, barW, bh);
    }
  }

  // Peak label (top-left, away from the newest bars on the right)
  ctx.fillStyle = cssVar('--text-dim');
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('peak ' + peak + '/s', 2, 10);
}

function initGraph() {
  // Shift the buckets once per second; redraw only while the overview is visible.
  setInterval(() => {
    buckets.pop();
    buckets.unshift({ block: 0, hide: 0, poison: 0 });
    if ($('view-overview').classList.contains('active')) drawGraph();
  }, 1000);
  window.addEventListener('resize', drawGraph);
}

let counterRefreshTimer = null;
let boardRefreshTimer = null;
function initSSE() {
  const es = new EventSource('/api/stats/stream');
  es.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (_) { return; }
    appendFeedItem(data);
    if (data.type in buckets[0]) buckets[0][data.type]++;
    // Coalesce refreshes: bursts of events would otherwise hammer the API.
    if (!counterRefreshTimer) {
      counterRefreshTimer = setTimeout(() => { counterRefreshTimer = null; refreshCounters(); }, 400);
    }
    if (data.type === 'block' && !boardRefreshTimer) {
      boardRefreshTimer = setTimeout(() => { boardRefreshTimer = null; loadLeaderboard(); }, 1500);
    }
    if (data.type === 'click' && $('view-vault').classList.contains('active')) loadVault();
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

// ---------------------------------------------------------------------------
// Rules view
// ---------------------------------------------------------------------------

function countRules(text) {
  return text.split('\n').filter(l => { const t = l.trim(); return t && !t.startsWith('!'); }).length;
}

async function loadRules() {
  try {
    const { text } = await api('GET', '/api/rules');
    $('rulesEditor').value = text;
    $('ruleCount').textContent = countRules(text);
  } catch (e) { notify('Error loading rules: ' + e.message); }
}

function initRules() {
  $('rulesEditor').addEventListener('input', (ev) => { $('ruleCount').textContent = countRules(ev.target.value); });

  $('btnSaveRules').addEventListener('click', async () => {
    try {
      await api('PUT', '/api/rules', { text: $('rulesEditor').value });
      notify('Rules saved');
    } catch (e) { notify('Error: ' + e.message); }
  });

  $('btnExport').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/export', { headers: { 'X-GhettoBlocker': '1' } });
      if (!r.ok) throw new Error('Export failed: ' + r.status);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ghetto-blocker-backup.json';
      a.click();
      URL.revokeObjectURL(url);
      notify('Backup exported');
    } catch (e) { notify('Error: ' + e.message); }
  });

  $('importFile').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const { count } = await api('POST', '/api/import', backup);
      await loadRules();
      notify('Imported ' + count + ' rules');
    } catch (e) { notify('Error: ' + e.message); }
    ev.target.value = '';
  });
}

// ---------------------------------------------------------------------------
// Sites view + leaderboard
// ---------------------------------------------------------------------------

function renderList(ulId, items, removeHandler) {
  const ul = $(ulId);
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None';
    ul.appendChild(li);
    return;
  }
  items.forEach(host => {
    const li = document.createElement('li');
    li.textContent = host;
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', () => removeHandler(host));
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

async function loadSites() {
  try {
    const [al, bp] = await Promise.all([api('GET', '/api/allowlist'), api('GET', '/api/bypass')]);
    renderList('allowlistItems', al.allowlist, async (host) => {
      await api('DELETE', '/api/allowlist', { host });
      notify('Removed: ' + host);
      loadSites();
    });
    renderList('bypassItems', bp.bypassHosts, async (host) => {
      await api('DELETE', '/api/bypass', { host });
      notify('Bypass removed: ' + host);
      loadSites();
    });
  } catch (e) { notify('Error: ' + e.message); }
}

async function loadLeaderboard() {
  try {
    const st = await api('GET', '/api/stats');
    const board = $('siteLeaderboard');
    const entries = Object.entries(st.sites)
      .filter(([, s]) => s.blocked > 0)
      .sort((a, b) => b[1].blocked - a[1].blocked)
      .slice(0, 12);
    board.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'board-empty';
      empty.textContent = 'Nothing blocked yet';
      board.appendChild(empty);
      return;
    }
    const max = entries[0][1].blocked;
    for (const [host, s] of entries) {
      const row = document.createElement('div');
      row.className = 'leaderboard-row';
      const h = document.createElement('span'); h.className = 'host'; h.textContent = host;
      const c = document.createElement('span'); c.className = 'count'; c.textContent = fmt(s.blocked);
      const bar = document.createElement('div'); bar.className = 'bar';
      const fill = document.createElement('i'); fill.style.width = Math.max(4, Math.round((s.blocked / max) * 100)) + '%';
      bar.appendChild(fill);
      row.append(h, c, bar);
      board.appendChild(row);
    }
  } catch (e) { notify('Error: ' + e.message); }
}

// ---------------------------------------------------------------------------
// Vault view (AdNauseam)
// ---------------------------------------------------------------------------

async function loadVault() {
  try {
    const { clicked, entries } = await api('GET', '/api/adnauseam/vault');
    $('vaultSummary').textContent = fmt(clicked) + ' ads clicked all-time · showing last ' + entries.length;
    const list = $('vaultList');
    list.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'board-empty';
      empty.textContent = 'No ads clicked yet';
      list.appendChild(empty);
      return;
    }
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'vault-row';
      const t = document.createElement('span'); t.className = 'time'; t.textContent = timeLabel(e.ts);
      const n = document.createElement('span'); n.className = 'net'; n.textContent = e.host;
      const pg = document.createElement('span'); pg.className = 'page';
      try { pg.textContent = 'on ' + new URL(e.page).hostname; } catch { pg.textContent = 'on ' + e.page; }
      const u = document.createElement('span'); u.className = 'url'; u.textContent = e.url; u.title = e.url;
      row.append(t, n, pg, u);
      list.appendChild(row);
    }
  } catch (e) { notify('Error: ' + e.message); }
}

function initSites() {
  const add = (inputId, path, label) => async () => {
    const host = $(inputId).value.trim();
    if (!host) return;
    try {
      await api('POST', path, { host });
      $(inputId).value = '';
      notify(label + ': ' + host);
      loadSites();
    } catch (e) { notify('Error: ' + e.message); }
  };
  $('btnAddAllowlist').addEventListener('click', add('allowlistInput', '/api/allowlist', 'Allowed'));
  $('btnAddBypass').addEventListener('click', add('bypassInput', '/api/bypass', 'Bypass added'));
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  initViews();
  initControls();
  initFeedChips();
  initRules();
  initSites();

  initLists();
  initUpdates();
  try {
    const state = await api('GET', '/api/state');
    applySettings(state.settings);
    applyState(state);
  } catch (e) {
    notify('Could not connect to control server: ' + e.message);
  }

  const feed = $('activityFeed');
  const empty = document.createElement('div');
  empty.className = 'feed-empty';
  empty.textContent = 'Waiting for traffic…';
  feed.appendChild(empty);

  await loadRules();
  await loadLeaderboard();
  initGraph();
  drawGraph();
  initSSE();
  // Keep the leaderboard fresh while the overview is open.
  setInterval(() => { if ($('view-overview').classList.contains('active')) loadLeaderboard(); }, 10_000);
}

document.addEventListener('DOMContentLoaded', init);
