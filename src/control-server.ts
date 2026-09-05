import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { parse as parseDomain } from 'tldts';
import type { RuntimeContext } from './runtime.js';
import type { Settings } from './state.js';
import type { BrowsersResponse, ClickRequest, CosmeticsRequest, CosmeticsResponse, ExportBackup, StateResponse, VaultResponse } from './api-types.js';
import { isBypassed } from './util.js';
import { detectBrowsers, launchBrowser, launchFlags, runningState } from './browsers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum body size accepted by the bulk routes (1 MB). */
const LARGE_BODY_LIMIT = 1_000_000;

/** Routes that legitimately carry large bodies: backup files, and the per-page
 *  class/id/href feature sets the extension sends (a big page has thousands). */
const LARGE_BODY_ROUTES = new Set(['/api/import', '/api/cosmetics']);

/** Maximum body size accepted by any other API route (64 KB).
 *  Enforced before the CSRF check so a malicious page cannot stream
 *  an unbounded body to exhaust the server's heap. */
const REQUEST_BODY_LIMIT = 64_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json',
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isValidHost(host: string, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isMutatingMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** True for extension origins and loopback dashboard origins. */
function isTrustedOrigin(origin: string): boolean {
  if (origin.startsWith('chrome-extension://')) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

function parseJsonBody(rawBody: Buffer): unknown {
  if (rawBody.length === 0) return {};
  return JSON.parse(rawBody.toString('utf8'));
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isHostList = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.every((h) => typeof h === 'string' && h.length > 0 && h.length <= 253 && !/[\s/]/.test(h));

/** Per-field validators: the settings file is only ever written from here, so this is the trust boundary. */
const SETTINGS_VALIDATORS: { [K in keyof Settings]: (v: unknown) => v is Settings[K] } = {
  paused: isBool,
  injectCosmetics: isBool,
  stripCSP: isBool,
  antiAnalytics: isBool,
  theme: (v): v is Settings['theme'] =>
    v === 'terminal' || v === 'cyberpunk' || v === 'daylight',
  controlPort: (v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535,
  autostart: isBool,
  adNauseam: isBool,
  allowlist: isHostList,
  bypassHosts: isHostList,
};

/**
 * Validate a settings patch: every key must be a known setting with a value of
 * the right shape. Returns the typed patch, or the name of the first bad field.
 */
export function validateSettingsPatch(
  input: unknown,
): { patch: Partial<Settings>; error?: undefined } | { patch?: undefined; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'settings patch must be an object' };
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const validate = (SETTINGS_VALIDATORS as Record<string, (v: unknown) => boolean>)[key];
    if (!validate || !Object.hasOwn(SETTINGS_VALIDATORS, key)) {
      return { error: `unknown setting: ${key}` };
    }
    if (!validate(value)) return { error: `invalid value for setting: ${key}` };
    patch[key] = value;
  }
  return { patch: patch as Partial<Settings> };
}

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Count importable lines (non-empty, non-comment). */
function countRules(text: string): number {
  return text
    .split('\n')
    .filter((l) => { const t = l.trim(); return t.length > 0 && !t.startsWith('!'); })
    .length;
}

// ---------------------------------------------------------------------------
// Route result type
// ---------------------------------------------------------------------------

export interface RouteResult {
  status: number;
  body?: unknown;
  extraHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Pure route() function -- unit-testable without a live socket
// ---------------------------------------------------------------------------

/**
 * Handle an API request and return a result object.
 * No socket I/O; all mutations go through `ctx`.
 * SSE, OPTIONS, and static file serving are handled by the HTTP server wrapper.
 */
export async function route(
  method: string,
  pathname: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  port: number,
  ctx: RuntimeContext,
): Promise<RouteResult> {
  const m = method.toUpperCase();
  const host = String(headers['host'] ?? '');

  // 1. Host validation (all requests - defeats DNS rebinding).
  if (!isValidHost(host, port)) {
    return { status: 403, body: { error: 'invalid host' } };
  }

  // 2. CSRF custom-header check (mutating requests only).
  //    A simple cross-origin form cannot set custom headers without a preflight
  //    the server controls, so this defeats CSRF from foreign origins.
  if (isMutatingMethod(m) && headers['x-ghettoblocker'] !== '1') {
    return { status: 403, body: { error: 'missing X-GhettoBlocker header' } };
  }

  // ---- Read endpoints ----

  if (m === 'GET' && pathname === '/api/state') {
    const body: StateResponse = {
      settings: ctx.settings,
      totals: ctx.stats.totals,
      since: ctx.stats.since,
      lists: ctx.lists,
      version: ctx.version,
      update: ctx.updates.status,
      setup: {
        caTrusted: ctx.setup.caTrusted,
        trafficSeenAt: ctx.setup.trafficSeenAt,
        extensionSeenAt: ctx.setup.extensionSeenAt,
        extensionDir: ctx.setup.extensionDir,
        canAct: typeof ctx.setup.installCa === 'function',
      },
    };
    return { status: 200, body };
  }

  if (m === 'POST' && pathname === '/api/setup/install-ca') {
    if (!ctx.setup.installCa) {
      return { status: 409, body: { error: 'run scripts\\install-ca.ps1 as administrator (headless mode)' } };
    }
    await ctx.setup.installCa();
    return { status: 200, body: { caTrusted: ctx.setup.caTrusted } };
  }

  if (m === 'POST' && pathname === '/api/setup/open-extension-dir') {
    if (!ctx.setup.openExtensionDir) {
      return { status: 409, body: { error: 'not available in headless mode', extensionDir: ctx.setup.extensionDir } };
    }
    ctx.setup.openExtensionDir();
    return { status: 200, body: { ok: true, extensionDir: ctx.setup.extensionDir } };
  }

  if (m === 'GET' && pathname === '/api/browsers') {
    const found = detectBrowsers();
    const states = await Promise.all(found.map((b) => runningState(b.exe)));
    const body: BrowsersResponse = {
      browsers: found.map((b, i) => ({ id: b.id, name: b.name, running: states[i] ?? 'unknown' })),
      flags: launchFlags(ctx.proxyPort),
    };
    return { status: 200, body };
  }

  if (m === 'POST' && pathname === '/api/browsers/launch') {
    let body: { id?: unknown; url?: unknown };
    try {
      body = parseJsonBody(rawBody) as { id?: unknown; url?: unknown };
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    const browser = detectBrowsers().find((b) => b.id === body.id);
    if (!browser) return { status: 404, body: { error: 'browser not found' } };
    const state = await runningState(browser.exe);
    if (state === 'unproxied') {
      return {
        status: 409,
        body: { error: `${browser.name} is already running without the proxy. Quit it completely, then launch it from here.` },
      };
    }
    launchBrowser(browser, ctx.proxyPort, typeof body.url === 'string' ? body.url : undefined);
    return { status: 200, body: { ok: true, name: browser.name, alreadyProxied: state === 'proxied' } };
  }

  if (m === 'POST' && pathname === '/api/update/check') {
    if (!ctx.updates.check) {
      return { status: 409, body: { error: 'updates are not available in this mode' } };
    }
    try {
      await ctx.updates.check();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.updates.setStatus({ state: 'error', message });
    }
    return { status: 200, body: { update: ctx.updates.status } };
  }

  if (m === 'POST' && pathname === '/api/update/install') {
    if (!ctx.updates.install || ctx.updates.status.state !== 'ready') {
      return { status: 409, body: { error: 'no update is ready to install' } };
    }
    ctx.updates.install();
    return { status: 200, body: { ok: true } };
  }

  if (m === 'GET' && pathname === '/api/stats') {
    return {
      status: 200,
      body: {
        totals: ctx.stats.totals,
        sites: ctx.stats.sites,
        recentActivity: ctx.stats.getRecentActivity(),
        brokenReports: ctx.stats.getBrokenReports(),
      },
    };
  }

  if (m === 'GET' && pathname === '/api/rules') {
    return { status: 200, body: { text: ctx.getUserRules() } };
  }

  if (m === 'GET' && pathname === '/api/allowlist') {
    return { status: 200, body: { allowlist: ctx.settings.allowlist } };
  }

  if (m === 'GET' && pathname === '/api/bypass') {
    return { status: 200, body: { bypassHosts: ctx.settings.bypassHosts } };
  }

  if (m === 'GET' && pathname === '/api/export') {
    const backup: ExportBackup = {
      version: 1,
      settings: ctx.settings,
      userRules: ctx.getUserRules(),
      exportedAt: Date.now(),
    };
    return {
      status: 200,
      body: backup,
      extraHeaders: {
        'content-disposition': 'attachment; filename="ghetto-blocker-backup.json"',
      },
    };
  }

  // ---- Mutating endpoints ----

  if (m === 'POST' && pathname === '/api/settings') {
    let raw: unknown;
    try {
      raw = parseJsonBody(rawBody);
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    const validated = validateSettingsPatch(raw);
    if (validated.error !== undefined) {
      return { status: 400, body: { error: validated.error } };
    }
    await ctx.updateSettings(validated.patch);
    return { status: 200, body: { settings: ctx.settings } };
  }

  if (m === 'POST' && pathname === '/api/cosmetics') {
    let body: Partial<CosmeticsRequest>;
    try {
      body = parseJsonBody(rawBody) as Partial<CosmeticsRequest>;
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof body.url !== 'string') {
      return { status: 400, body: { error: 'missing url field' } };
    }
    const lifecycle = body.lifecycle ?? 'start';
    if (lifecycle !== 'start' && lifecycle !== 'dom-update') {
      return { status: 400, body: { error: 'invalid lifecycle field' } };
    }
    if (ctx.setup.extensionSeenAt === null) {
      // First contact from the extension: remember it (persisted) for the setup checklist.
      ctx.setup.extensionSeenAt = Date.now();
      void ctx.updateSettings({ extensionSeenAt: ctx.setup.extensionSeenAt }).catch(() => { /* best-effort */ });
    }
    const classes = body.classes ?? [];
    const ids = body.ids ?? [];
    const hrefs = body.hrefs ?? [];
    if (!isStringList(classes) || !isStringList(ids) || !isStringList(hrefs)) {
      return { status: 400, body: { error: 'classes/ids/hrefs must be string arrays' } };
    }
    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      return { status: 400, body: { error: 'invalid url' } };
    }
    const inactive: CosmeticsResponse = { active: false, styles: '', extended: [] };
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { status: 200, body: inactive };
    }
    const { settings } = ctx;
    const hostname = parsed.hostname;
    if (
      settings.paused ||
      !settings.injectCosmetics ||
      isBypassed(hostname, settings.bypassHosts) ||
      isBypassed(hostname, settings.allowlist)
    ) {
      return { status: 200, body: inactive };
    }
    // The proxy already injected the base stylesheet and scriptlets into the
    // document; the extension only needs what the DOM unlocks plus, on first
    // call, the hostname rules (for their procedural entries).
    const cosmetics = ctx.getCosmetics({
      url: body.url,
      hostname,
      domain: parseDomain(hostname).domain ?? undefined,
      classes,
      ids,
      hrefs,
      getBaseRules: false,
      getRulesFromHostname: lifecycle === 'start',
      getInjectionRules: false,
    });
    const response: CosmeticsResponse = {
      active: true,
      adNauseam: settings.adNauseam,
      styles: cosmetics.styles,
      extended: cosmetics.extended,
    };
    return { status: 200, body: response };
  }

  if (m === 'POST' && pathname === '/api/adnauseam/click') {
    let body: Partial<ClickRequest>;
    try {
      body = parseJsonBody(rawBody) as Partial<ClickRequest>;
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof body.url !== 'string' || typeof body.page !== 'string') {
      return { status: 400, body: { error: 'missing url/page field' } };
    }
    let target: URL;
    try {
      target = new URL(body.url);
    } catch {
      return { status: 400, body: { error: 'invalid url' } };
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { status: 400, body: { error: 'invalid url' } };
    }
    if (!ctx.settings.adNauseam) {
      return { status: 409, body: { error: 'AdNauseam mode is off' } };
    }
    const meta: { image?: string; title?: string } = {};
    if (typeof body.image === 'string' && /^https?:\/\//i.test(body.image)) meta.image = body.image.slice(0, 2048);
    if (typeof body.title === 'string' && body.title.trim()) meta.title = body.title.trim().slice(0, 120);
    ctx.registerPendingClick(target.href, body.page.slice(0, 512), meta);
    return { status: 200, body: { ok: true } };
  }

  if (m === 'GET' && pathname === '/api/adnauseam/vault') {
    const body: VaultResponse = { clicked: ctx.stats.totals.clicked, entries: ctx.stats.getVault() };
    return { status: 200, body };
  }

  if (m === 'DELETE' && pathname === '/api/adnauseam/vault') {
    ctx.stats.clearVault();
    return { status: 200, body: { ok: true } };
  }

  if (m === 'PUT' && pathname === '/api/rules') {
    let body: { text?: unknown };
    try {
      body = parseJsonBody(rawBody) as { text?: unknown };
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof body.text !== 'string') {
      return { status: 400, body: { error: 'missing text field' } };
    }
    await ctx.setUserRules(body.text);
    return { status: 200, body: { ok: true } };
  }

  if (m === 'POST' && pathname === '/api/rules/append') {
    let body: { rule?: unknown };
    try {
      body = parseJsonBody(rawBody) as { rule?: unknown };
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof body.rule !== 'string') {
      return { status: 400, body: { error: 'missing rule field' } };
    }
    const current = ctx.getUserRules();
    const next = current ? `${current}\n${body.rule}` : body.rule;
    await ctx.setUserRules(next);
    return { status: 200, body: { ok: true } };
  }

  if (m === 'POST' && pathname === '/api/allowlist') {
    let body: { host?: unknown };
    try {
      body = parseJsonBody(rawBody) as { host?: unknown };
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof body.host !== 'string') {
      return { status: 400, body: { error: 'missing host field' } };
    }
    const list = ctx.settings.allowlist;
    if (!list.includes(body.host)) {
      await ctx.updateSettings({ allowlist: [...list, body.host] });
    }
    return { status: 200, body: { allowlist: ctx.settings.allowlist } };
  }

  if (m === 'DELETE' && pathname === '/api/allowlist') {
    let body: { host?: unknown };
    try {
      body = parseJsonBody(rawBody) as { host?: unknown };
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof body.host !== 'string') {
      return { status: 400, body: { error: 'missing host field' } };
    }
    await ctx.updateSettings({
      allowlist: ctx.settings.allowlist.filter((h) => h !== body.host),
    });
    return { status: 200, body: { allowlist: ctx.settings.allowlist } };
  }

  if (m === 'POST' && pathname === '/api/bypass') {
    let body: { host?: unknown };
    try {
      body = parseJsonBody(rawBody) as { host?: unknown };
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof body.host !== 'string') {
      return { status: 400, body: { error: 'missing host field' } };
    }
    const list = ctx.settings.bypassHosts;
    if (!list.includes(body.host)) {
      await ctx.updateSettings({ bypassHosts: [...list, body.host] });
    }
    return { status: 200, body: { bypassHosts: ctx.settings.bypassHosts } };
  }

  if (m === 'DELETE' && pathname === '/api/bypass') {
    let body: { host?: unknown };
    try {
      body = parseJsonBody(rawBody) as { host?: unknown };
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof body.host !== 'string') {
      return { status: 400, body: { error: 'missing host field' } };
    }
    await ctx.updateSettings({
      bypassHosts: ctx.settings.bypassHosts.filter((h) => h !== body.host),
    });
    return { status: 200, body: { bypassHosts: ctx.settings.bypassHosts } };
  }

  if (m === 'POST' && pathname === '/api/import') {
    if (rawBody.length > LARGE_BODY_LIMIT) {
      return { status: 413, body: { error: 'body too large' } };
    }
    let backup: Partial<ExportBackup>;
    try {
      backup = parseJsonBody(rawBody) as Partial<ExportBackup>;
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof backup.userRules !== 'string') {
      return { status: 400, body: { error: 'missing userRules field' } };
    }
    await ctx.setUserRules(backup.userRules);
    return { status: 200, body: { count: countRules(backup.userRules) } };
  }

  if (m === 'POST' && pathname === '/api/lists/update') {
    try {
      const builtAt = await ctx.updateLists();
      return { status: 200, body: { builtAt } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 502, body: { error: `list update failed: ${message}` } };
    }
  }

  if (m === 'POST' && pathname === '/api/broken-report') {
    let body: { host?: unknown; comment?: unknown };
    try {
      body = parseJsonBody(rawBody) as { host?: unknown; comment?: unknown };
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof body.host !== 'string') {
      return { status: 400, body: { error: 'missing host field' } };
    }
    ctx.stats.addBrokenReport({
      host: body.host,
      comment: typeof body.comment === 'string' ? body.comment : '',
      ts: Date.now(),
    });
    return { status: 200, body: { ok: true } };
  }

  return { status: 404, body: { error: 'not found' } };
}

// ---------------------------------------------------------------------------
// HTTP server wrapper (handles SSE, CORS OPTIONS, static files)
// ---------------------------------------------------------------------------

/**
 * Read all chunks from a request into a single Buffer.
 * Rejects with a 413-tagged error when the body exceeds `limit` bytes so the
 * heap is never exhausted before the CSRF check runs.
 */
async function readBody(req: http.IncomingMessage, limit = REQUEST_BODY_LIMIT): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) {
      // Drain the stream so the socket is reusable, then reject.
      req.resume();
      const err = new Error('body too large') as NodeJS.ErrnoException;
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Creative thumbnails: small in-memory cache so the vault grid doesn't refetch on every open. */
const THUMB_CACHE_CAP = 200;
const THUMB_MAX_BYTES = 1_500_000;
const thumbCache = new Map<string, { type: string; body: Buffer } | null>();

async function fetchThumb(url: string): Promise<{ type: string; body: Buffer } | null> {
  const cached = thumbCache.get(url);
  if (cached !== undefined) return cached;
  let result: { type: string; body: Buffer } | null = null;
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0' },
    });
    const type = r.headers.get('content-type') ?? '';
    if (r.ok && type.startsWith('image/')) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length <= THUMB_MAX_BYTES) result = { type, body: buf };
    }
  } catch {
    result = null;
  }
  if (thumbCache.size >= THUMB_CACHE_CAP) {
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
  thumbCache.set(url, result);
  return result;
}

/** Serve a file from the dashboard directory. */
async function serveStatic(
  pathname: string,
  res: http.ServerResponse,
  dashboardDir: string,
): Promise<void> {
  // Normalise the path -- serve index.html for /
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const filePath = join(dashboardDir, rel);
  // Prevent directory traversal.  Use sep suffix so a sibling directory
  // whose name shares a prefix with dashboardDir (e.g. /dashboard-evil) is
  // not accidentally allowed.
  if (!filePath.startsWith(dashboardDir + sep)) {
    res.writeHead(403).end();
    return;
  }
  const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': mime });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}

/**
 * Build and return the control-server HTTP server.
 * Call `server.listen(port)` to start.
 *
 * @param ctx - The shared RuntimeContext (read/mutated by API handlers).
 * @param dashboardDir - Absolute path to the static dashboard directory.
 *   Defaults to `<cwd>/public/dashboard` (correct for `npm start` in dev).
 */
export function createControlServer(
  ctx: RuntimeContext,
  dashboardDir = join(process.cwd(), 'public', 'dashboard'),
): http.Server {
  /** Active SSE response streams -- evicted on close or write error. */
  const sseClients = new Set<http.ServerResponse>();

  /** Broadcast to all connected SSE clients; evict on write error. */
  const broadcast = (data: string): void => {
    for (const client of [...sseClients]) {
      try {
        client.write(data);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  // Subscribe to activity events so they are pushed to SSE clients.
  const unsubscribeActivity = ctx.subscribe((ev) => {
    broadcast(`data: ${JSON.stringify(ev)}\n\n`);
  });

  // Heartbeat keeps long-lived EventSource connections alive through idle proxies.
  // SHORTCUT: 30s interval; tune if proxy timeouts cause disconnects.
  const heartbeatTimer = setInterval(() => {
    broadcast(': heartbeat\n\n');
  }, 30_000);
  heartbeatTimer.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const rawUrl = req.url ?? '/';
      const origin = String(req.headers['origin'] ?? '');
      let pathname: string;
      try {
        pathname = new URL(rawUrl, 'http://127.0.0.1').pathname;
      } catch {
        pathname = rawUrl.split('?')[0] ?? '/';
      }

      // Determine server port from address (available after listen() fires).
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : ctx.settings.controlPort;

      // ---- CORS headers for trusted origins ----
      if (origin && isTrustedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }

      // ---- OPTIONS preflight ----
      if (req.method === 'OPTIONS') {
        if (!origin || !isTrustedOrigin(origin)) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GhettoBlocker');
        res.setHeader('Access-Control-Max-Age', '86400');
        if (req.headers['access-control-request-private-network']) {
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
        res.writeHead(204).end();
        return;
      }

      // ---- SSE endpoint ----
      if (req.method === 'GET' && pathname === '/api/stats/stream') {
        const host = String(req.headers['host'] ?? '');
        if (!isValidHost(host, port)) {
          res.writeHead(403).end(JSON.stringify({ error: 'invalid host' }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        // Keep the connection open -- do NOT call res.end()
        return;
      }

      // ---- AdNauseam creative thumbnails ----
      // Fetched server-side so they render even when the browser would block
      // the ad host. Only URLs recorded in the vault are allowed (no SSRF).
      if (req.method === 'GET' && pathname === '/api/adnauseam/thumb') {
        const host = String(req.headers['host'] ?? '');
        if (!isValidHost(host, port)) {
          res.writeHead(403).end();
          return;
        }
        const wanted = new URL(rawUrl, 'http://127.0.0.1').searchParams.get('u') ?? '';
        if (!ctx.stats.getVault().some((e) => e.image === wanted)) {
          res.writeHead(404).end();
          return;
        }
        const thumb = await fetchThumb(wanted);
        if (!thumb) {
          res.writeHead(502).end();
          return;
        }
        res.writeHead(200, { 'content-type': thumb.type, 'cache-control': 'private, max-age=86400' });
        res.end(thumb.body);
        return;
      }

      // ---- Static dashboard files ----
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        await serveStatic(pathname, res, dashboardDir);
        return;
      }

      // ---- API routes ----
      let rawBody: Buffer;
      try {
        const bodyLimit = LARGE_BODY_ROUTES.has(pathname) ? LARGE_BODY_LIMIT : REQUEST_BODY_LIMIT;
        rawBody = await readBody(req, bodyLimit);
      } catch (bodyErr) {
        const code = (bodyErr as NodeJS.ErrnoException).code;
        if (!res.headersSent) {
          const status = code === 'PAYLOAD_TOO_LARGE' ? 413 : 500;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: (bodyErr as Error).message }));
        }
        return;
      }
      const result = await route(
        req.method ?? 'GET',
        pathname,
        req.headers as Record<string, string | string[] | undefined>,
        rawBody,
        port,
        ctx,
      );

      const extraHeaders = result.extraHeaders ?? {};
      res.writeHead(result.status, {
        'content-type': 'application/json',
        ...extraHeaders,
      });
      res.end(result.body !== undefined ? JSON.stringify(result.body) : '');
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500).end(JSON.stringify({ error: 'internal server error' }));
      }
    }
  });

  // Clean up subscriptions and timers when the server is closed.
  server.on('close', () => {
    clearInterval(heartbeatTimer);
    unsubscribeActivity();
  });

  return server;
}
