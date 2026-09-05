# Electron Control App + MV3 Element Picker Implementation Plan

Created: 2026-06-21
Author: exploitz
Agent: Claude Code
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Turn ghetto-blocker from a headless `npm start` proxy into a packaged Windows desktop app — a tray-resident Electron process running the existing filtering proxy plus a local control server + themeable dashboard (pause/resume, cosmetics toggle, custom-rules manager, per-site allowlist, bypass editor, live stats + activity feed, import/export, broken-site report, anti-analytics), a hot-reloadable user-rules layer merged into the adblocker engine, and an MV3 extension that lets you click an element to create a persistent hide rule.

## Context for Implementer

Today everything is wired through `createProxy(engine, config)` (`src/proxy.ts:27`), which closes over an **immutable** `config` and a **single, static** `FiltersEngine`. Live control (pause, toggles, hot-reloaded user rules, per-site allowlist) is impossible against frozen closures. The core architectural move is to introduce a **mutable `RuntimeContext`** (settings + base engine + user engine + stats) that the proxy reads on every request, and that the control server mutates. Everything else (dashboard, extension, Electron, packaging) hangs off that context.

Key facts established during planning:
- All deps are **pure JS** (no `.node` addons) → Electron asar packaging is clean, no `electron-rebuild`.
- `ctx.proxyToServerRequestOptions` (host/port/path/headers) is built *before* `onRequest` handlers run (`http-mitm-proxy/dist/lib/proxy.js:869`), so the proxy could rewrite outbound URL/headers inside `onRequest` if needed. (Anti-analytics this phase uses a client-facing 302 instead; referer trimming is deferred — see Out of Scope.)
- `FiltersEngine.parse(text, {loadNetworkFilters, loadCosmeticFilters})` builds a fully-functional engine supporting both `.match()` and `.getCosmeticsFilters()` from a tiny inline list (proven by `test/engine.test.ts:5`). This is the basis for the **two-engine** user-rules layer (base prebuilt engine + small user engine, queried together) — no fragile mutation of the big serialized engine, and hot-reload = re-parse the small user list.
- Loopback is excluded from the browser proxy (`--proxy-bypass-list="<-loopback>"`), so the extension and dashboard reach `http://127.0.0.1:8081` **directly**, not through the proxy.

## Approach

**Chosen:** Introduce `RuntimeContext` (`src/runtime.ts`) wrapping a mutable `Settings`, the prebuilt base engine, a re-parseable user engine, and live `Stats`. Refactor `createProxy` to consume it. Add a `src/control-server.ts` HTTP API + static dashboard, an `extension/` MV3 picker, and an `electron/` wrapper, with a shared `bootstrap()` used by both the headless and Electron entry points.

**Why:** The two-engine context gives live control and instant rule hot-reload without rebuilding the multi-MB prebuilt engine, and keeps the existing proxy/engine code largely intact (lowest-risk path to a controllable, packageable app). Cost: a one-time refactor of `proxy.ts` and its integration test to read from the context instead of closures.

## Out of Scope

- **Full AdNauseam ad-clicking** (background-clicking hidden ads to flood ad networks) — deferred to a follow-up phase (needs page DOM, carries detection/click-fraud risk). See Deferred Ideas.
- **Tracker-cookie ID rotation** — folded into the deferred AdNauseam phase; doing it safely needs per-tracker knowledge. This phase ships the robust anti-analytics win: tracking-param stripping.
- **Proxy-side referrer trimming** — moved to Deferred Ideas. Target Chromium (Vivaldi) already defaults to `strict-origin-when-cross-origin`, so cross-site referrers are already origin-only; a proxy-side trim is near-redundant for the stated runtime and adds per-request header-mutation surface for no real gain (build-the-least-that-works). Param stripping is the anti-analytics deliverable this phase.
- **Auto-installing the extension into Vivaldi** — Chromium has no API for that; the installer ships the extension files + load-unpacked instructions.
- **macOS / Linux installers** — Windows NSIS only this phase.
- **Auto-update** — not wired this phase.

## Autonomous Decisions

- **Dashboard = vanilla HTML/CSS/JS** served by the control server (no build step, identical visual ceiling). Confirmed with user.
- **Three selectable themes** via CSS variables + `data-theme` root attribute: `terminal` (neon, default), `glass` (dark), `synthwave`. Theme persists in settings.
- **Extension is build-free static files** (loaded unpacked). Selector generation is a compact inline heuristic (id → unique class → `:nth-child` path) with a confirm/preview step before saving — robust enough for a personal tool, no bundled dependency. SHORTCUT trigger: picker repeatedly mis-targets → swap in `@medv/finder`.
- **Proxy & control server run in the Electron main process** (full Node context) — no child-process/IPC split.
- **Control server port 8081** (configurable in settings).
- **Testing posture: parsimonious** (global default) — reuse/extend the existing integration test; add focused unit tests only for new pure logic.

## Runtime Environment

- **Headless dev:** `npm start` (`tsx src/index.ts`) — runs proxy + control server; dashboard at `http://127.0.0.1:8081`. Platform-agnostic (Node), so usable for E2E on the dev box.
- **Packaged app:** `npm run electron:dev` (dev) / `npm run dist` (build NSIS). Windows-only runtime concerns (tray, CA install, installer).
- **Control server health check:** `GET http://127.0.0.1:8081/api/state` → 200 JSON.

## Assumptions

- `http-mitm-proxy` invokes `onResponse`/`onRequest` handlers per the v1.1.0 contract verified during planning (`onResponseData`/`onResponseEnd` for body rewrite as already used in `src/proxy.ts:157`). Task 3 depends on this.
- Electron's `BrowserWindow` can load `http://127.0.0.1:8081/` for the dashboard (local server already running in-process). Task 7 depends on this.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| MV3 service-worker fetch to `127.0.0.1` blocked by Private Network Access | Medium | High (picker can't save) | Control server answers CORS preflight with `Access-Control-Allow-Private-Network: true` + echoes the extension origin; SW declares `host_permissions: ["http://127.0.0.1:8081/*"]`. Verified by the picker E2E (TS-005). |
| **CSRF / DNS-rebinding against the loopback control server** — any page the user visits can `POST` to `127.0.0.1:8081`; loopback binding + `ACAO:*` does NOT prevent the mutation (simple cross-origin `POST`s with `text/plain`/form bodies skip preflight and execute server-side regardless of CORS) | Medium | **High** (a hostile page could add a bypass/allowlist entry disabling blocking, or inject a user-rule) | Mutating endpoints (`POST /api/settings`, `PUT/POST /api/rules*`, allowlist/bypass mutators, `/api/import`) **require** a custom header `X-GhettoBlocker: 1` (simple cross-origin requests cannot set it without a preflight the server controls) **and** validate `Host` is exactly `127.0.0.1:PORT`/`localhost:PORT` (defeats DNS-rebinding). CORS scoped to the extension origin, not `*`. Tested: mutating request lacking the header or with a foreign `Host` → 403. |
| esbuild bundling breaks a dynamic `require` in `http-mitm-proxy`/`node-forge` | Medium | Med | Compile only our own TS; keep node deps **external** and let electron-builder package `node_modules`. |
| Anti-analytics 302 loop (stripped URL still has a param) | Low | Med | Only redirect when stripping actually changes the URL; never redirect to a URL that still matches the strip set. Unit-tested. |
| Anti-analytics 302 silently converts a `main_frame` **POST → GET**, dropping the body (breaks logins/form submits) | Medium | **High** | Redirect ONLY when `request.method === 'GET'`; non-GET navigations pass through untouched. Unit + integration tested (TS-004 sub-case). |
| Picker `host##selector` user-rule not emitted by `getCosmeticsFilters` (specific class/id rules can be gated behind `getRulesFromDOM`, which the proxy disables) | Low–Med | High (TS-005 fails) | Picker rules are **hostname-specific** so they surface via `getRulesFromHostname:true` (already set at `proxy.ts:125`; proven for `example.com##.ad-banner` in `test/engine.test.ts`). Task 2 DoD asserts this; fallback = emit user hide-rules as direct `display:none` CSS for the hostname, bypassing the engine. |

## Goal Verification

### Truths

1. With the app running, toggling **Pause** in the dashboard immediately stops all network blocking and cosmetic injection for new requests, and toggling it back restores them — without restarting the proxy (cross-task: state + proxy + control server + dashboard).
2. Clicking an element with the extension picker creates a persistent hide rule that survives a proxy restart and hides that element on reload (cross-task: extension + control server + user-rules layer + proxy cosmetics).

## E2E Test Scenarios

### TS-001: Pause/resume stops and restores filtering
**Priority:** Critical
**Preconditions:** App running (`npm start`), dashboard open at `http://127.0.0.1:8081`, a test page that loads a known-blocked tracker.
**Mapped Tasks:** 1, 3, 4, 5

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Load dashboard | Status shows "Blocking active", live block counter > 0 after browsing |
| 2 | Click Pause | Status flips to "Paused"; `GET /api/state` shows `paused:true` |
| 3 | Re-request a tracker through the proxy | Request is NOT blocked (passes through) |
| 4 | Click Resume | Status "Blocking active"; tracker blocked again |

### TS-002: Add a custom network rule, see it block live
**Priority:** Critical
**Preconditions:** App running; dashboard Rules tab.
**Mapped Tasks:** 1, 2, 3, 4, 5

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | In Rules editor add `||testtracker.example^`, Save | `PUT /api/rules` 200; toast "rules reloaded" |
| 2 | Request `https://testtracker.example/x.js` via proxy | Blocked (0-byte 200) without restart |

### TS-003: Theme switcher
**Priority:** Medium
**Preconditions:** Dashboard open.
**Mapped Tasks:** 1, 5

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Select "Synthwave" in theme switcher | `data-theme="synthwave"` on root; colors change instantly |
| 2 | Reload dashboard | Theme persists (read from settings) |

### TS-004: Anti-analytics strips tracking params (GET-only)
**Priority:** High
**Preconditions:** App running; anti-analytics ON. **Use an `http://` target** (e.g. a local fixture server) so no CA/HTTPS setup is needed to exercise the 302 on the linux dev box; the same logic applies to HTTPS.
**Mapped Tasks:** 3

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | `GET` (main_frame) `http://fixture.test/?utm_source=x&gclid=y&id=5` via proxy | 302 to `http://fixture.test/?id=5`; "trackers poisoned" counter increments |
| 2 | `GET` `http://fixture.test/?id=5` (no tracking params) | No redirect; served normally |
| 3 | `POST` (main_frame) `http://fixture.test/?utm_source=x` with a body | NOT redirected — request passes through with body intact (302 would drop the body) |

### TS-005: Extension picker creates a persistent hide rule
**Priority:** Critical
**Preconditions:** App running; extension loaded unpacked in a Chromium browser launched with `--proxy-server="127.0.0.1:8080" --proxy-bypass-list="<-loopback>"` (so the dashboard + extension reach `127.0.0.1:8081` directly) **and** the proxy CA trusted — either import the generated CA or launch with `--ignore-certificate-errors` for the test run. The cosmetic-injection half (does the saved rule hide the element?) is independently provable on the dev box via TS of Task 2's `getCosmetics` assertion + an `http://` fixture page through the proxy, even without the browser CA set up; the full extension click-through is the Chromium-with-CA path.
**Mapped Tasks:** 2, 5, 6

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click extension action → "Pick element to block" | Hover overlay highlights elements |
| 2 | Click a target element | Preview shows generated selector `host##selector`; confirm |
| 3 | Confirm | SW POSTs to `/api/rules/append`; toast "rule saved" |
| 4 | Reload the page | Element is hidden; rule visible in dashboard Rules tab |
| 5 | Restart proxy, reload page | Element still hidden (rule persisted) |

### TS-006: One-click bypass fixes a site
**Priority:** High
**Preconditions:** Dashboard Sites tab.
**Mapped Tasks:** 1, 3, 4, 5

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Enter a host and click "Bypass this site" | Host added to bypass list; `GET /api/state` shows it |
| 2 | Request that host via proxy | Passes through completely unfiltered |
| 3 | Click "Un-bypass" | Host removed; filtering resumes |

## Progress Tracking

- [x] Task 1: State & persistence layer (settings, allowlist, bypass, user-rules, stats)
- [x] Task 2: RuntimeContext + two-engine user-rules layer (hot reload)
- [x] Task 3: Proxy refactor onto RuntimeContext + anti-analytics + per-site stats
- [x] Task 4: Control server HTTP API + CORS/PNA + SSE live feed
- [x] Task 5: Dashboard UI (3 themes, all features)
- [x] Task 6: MV3 picker/zapper extension
- [x] Task 7: Electron app + shared bootstrap (tray, window, autostart, CA install)
- [x] Task 8: Build + packaging (esbuild, electron-builder NSIS) + docs

## Implementation Tasks

### Task 1: State & persistence layer

**Objective:** Create the mutable, persisted state that replaces the immutable `config` singleton for runtime-controllable fields. Defines `Settings` (paused, injectCosmetics, stripCSP, antiAnalytics, theme, controlPort, autostart, allowlist, bypassHosts), `Stats` (totals + per-site map + recent-activity ring buffer), and load/save to disk. This is the foundation every later task reads/writes.

**Files:**
- Create: `src/paths.ts` (data-dir path helpers: settingsPath, userRulesPath, statsPath, broken-reports path — all under `~/.ghetto-blocker`)
- Create: `src/state.ts` (`Settings`/`Stats` types, `loadSettings`/`saveSettings`, `loadUserRules`/`saveUserRules`, `loadStats`/`saveStats` with debounced flush, defaults)
- Modify: `src/config.ts` (keep `sslCaDir`, `enginePath`, `engineTtlMs` as static install config; move the runtime-mutable fields' DEFAULTS into `state.ts` defaults; document the split)
- Test: `test/state.test.ts`

**Key Decisions / Notes:**
- Persist as: `settings.json` (one object incl. allowlist + bypassHosts), `user-rules.txt` (uBO syntax, plain text — natural format + what import/export round-trips), `stats.json` (debounced writes, in-memory authoritative, flush on interval + shutdown).
- `config.ts` keeps **install-level** config (cert dir, engine cache path/TTL); `state.ts` owns **runtime** config. Don't duplicate fields.
- Atomic writes (write temp + rename) to avoid corruption on crash.
- **Bound all growable collections** (review must_fix — a tray-resident process runs for days): per-site map keeps only hosts with `blocked > 0` and is capped at the top-N by count (LRU/min-count eviction, N≈500); the activity ring buffer is fixed-size (≈200); broken-site reports are capped (ring or max-count, ≈50). `GET /api/stats` returns only a top-N leaderboard slice, never the whole map, so the SSE/stats payload stays bounded.

**Definition of Done:**
- [ ] `loadSettings()` returns defaults when no file exists; round-trips after `saveSettings(patch)`
- [ ] `saveStats` debounces (no write storm) and flushes on demand
- [ ] Per-site map and broken-reports do not grow without bound (assert eviction past the cap); the serialized stats payload stays bounded
- [ ] Verify: `npx vitest run test/state.test.ts`

### Task 2: RuntimeContext + two-engine user-rules layer

**Objective:** Create `RuntimeContext` holding the base prebuilt engine, a re-parseable user engine, the `Settings`, and `Stats`. Provide combined `matchRequest()` (base then user), merged `getCosmetics()` (base + user styles/scripts concatenated), `setUserRules(text)` (re-parse user engine + persist + activity event), `updateSettings(patch)`, and `recordEvent()`. This is the hot-reload heart — changing rules re-parses only the small user list.

**Files:**
- Create: `src/runtime.ts` (`RuntimeContext` factory + methods)
- Modify: `src/engine.ts` (export a helper to parse a user-rules string into a `FiltersEngine`, mirroring `test/engine.test.ts:5` options)
- Test: `test/runtime.test.ts`

**Key Decisions / Notes:**
- User engine: `FiltersEngine.parse(text, { loadNetworkFilters: true, loadCosmeticFilters: true, enableCompression: false })` — empty/blank text → empty engine that matches nothing (guard parse errors, never throw into the request path).
- `matchRequest`: base `.match()` first; if no match, user `.match()`. Return first block/redirect.
- `getCosmetics`: call both engines' `getCosmeticsFilters` with the SAME options the proxy already uses (`getRulesFromHostname:true`, `getRulesFromDOM:false` — `proxy.ts:119-131`), concatenate `styles` and `scripts` (dedupe identical styles blocks).
- **User cosmetic rules must actually surface** (review should_fix): the picker saves `hostname##selector` (hostname-specific) rules. These come back through `getRulesFromHostname:true`, NOT `getRulesFromDOM` (that path is only for *generic*, non-hostname class/id rules) — proven for `example.com##.ad-banner` in `test/engine.test.ts`. Assert this in the DoD below. **Fallback if the engine path proves insufficient for picker selectors:** keep picker hide-rules in a simple `{hostname → selector[]}` map and emit them directly as `selector { display:none !important }` CSS for the matching hostname in `getCosmetics`, bypassing the user engine entirely. Pick the fallback only if the DoD assertion fails — don't pre-build it.
- Activity ring buffer: fixed size (e.g. 200) for the live feed; `recordEvent({type, host, url, rule})`.

**Definition of Done:**
- [ ] A rule added via `setUserRules` is matched by `matchRequest` without rebuilding the base engine
- [ ] `getCosmetics` returns merged styles from base + user engines
- [ ] A user rule `example.com##.ad-box` produces a hiding style for `example.com` in `getCosmetics` output (assert the selector text appears) — guards TS-005
- [ ] Malformed user-rules text does not throw; yields an engine matching nothing
- [ ] Verify: `npx vitest run test/runtime.test.ts`

### Task 3: Proxy refactor onto RuntimeContext + anti-analytics + per-site stats

**Objective:** Rewrite `createProxy` to take a `RuntimeContext` instead of `(engine, config)`. Read `paused`/`injectCosmetics`/`stripCSP`/`antiAnalytics`/allowlist/bypass live per request; route matching/cosmetics through the context; record per-site stats + activity events; add the anti-analytics layer (strip tracking query params via a **GET-only** 302 on navigations).

**Files:**
- Modify: `src/proxy.ts` (signature → `createProxy(ctx: RuntimeContext)`; gating; per-site stats; anti-analytics)
- Modify: `src/util.ts` (add pure `stripTrackingParams(url)` → `{url, changed}` over a known param set: `utm_*`, `gclid`, `fbclid`, `msclkid`, `dclid`, `gbraid`, `wbraid`, `mc_eid`, `igshid`, `_hsenc`, `_hsmi`, `yclid`, `ttclid`)
- Modify: `test/integration.test.ts` (construct a `RuntimeContext` instead of passing a raw engine; add pause + anti-analytics cases)
- Test: extend `test/util.test.ts` (stripTrackingParams)

**Key Decisions / Notes:**
- Gating order in `onRequest`: `paused` → passthrough; `isBypassed` → passthrough; allowlisted host → no block/cosmetics/anti-analytics (trusted); else filter.
- Anti-analytics 302 is **GET-only** (review must_fix): redirect to the cleaned URL only when `request.method === 'GET'` AND `stripTrackingParams` reports `changed`. A 302 forces the browser to re-issue as GET and discards the body — a non-GET `main_frame` navigation (login/search/checkout POST) carrying a tracking param must pass through **untouched**, never 302'd. Only redirect when stripping changes the URL (loop avoidance, Risks table).
- **Referer trimming dropped** (review suggestion — redundant with Chromium's `strict-origin-when-cross-origin` default; moved to Deferred Ideas). No `trimReferer` helper, no outbound header mutation this phase.
- Per-site stat key = `hostnameWithoutPort(host)`; increment blocked/hidden/poisoned; push activity event.
- **`onResponse` (cosmetics) must be registered UNCONDITIONALLY** and gated internally (review should_fix): today it is only registered when `config.injectCosmetics` is true (`proxy.ts:81-83`) — a build-time decision. Proxy handlers can't be added/removed at runtime, so for the live pause + cosmetics toggle the handler must always be registered and short-circuit inside `injectCosmetics` on `ctx.settings.injectCosmetics === false || ctx.settings.paused === true`.
- `stripCSP`, cosmetic buffering/decompress logic stays as-is (`src/proxy.ts:139-178`), just gated by `ctx.settings`.

**Definition of Done:**
- [ ] Existing integration tests pass against the new `RuntimeContext` signature
- [ ] `paused=true` → a known-blocked request passes through
- [ ] A `main_frame` **GET** with `utm_source` returns 302 to the cleaned URL; a clean URL is not redirected; a `main_frame` **POST** with `utm_source` passes through (NOT 302'd)
- [ ] Toggling `injectCosmetics` off via settings stops injection on the next request without restart (integration assertion)
- [ ] Per-site stats increment for the requested host
- [ ] Verify: `npx vitest run test/integration.test.ts test/util.test.ts`

### Task 4: Control server HTTP API + CORS/PNA + SSE

**Objective:** Add `src/control-server.ts` — a local `http` server (default `127.0.0.1:8081`) that serves the static dashboard and a JSON API over the `RuntimeContext`: read state/stats, patch settings, get/set/append rules, manage allowlist + bypass, import/export backup, broken-site report, and an SSE stream for the live activity feed + counters. Handles CORS + Private Network Access preflight for the extension.

**Files:**
- Create: `src/control-server.ts` (server factory `createControlServer(ctx)`, pure `route(req)` handler table)
- Create: `src/api-types.ts` (request/response shapes shared with dashboard + extension)
- Test: `test/control-server.test.ts`

**Key Decisions / Notes:**
- Endpoints: `GET /api/state`, `GET /api/stats`, `GET /api/stats/stream` (SSE), `POST /api/settings`, `GET|PUT /api/rules`, `POST /api/rules/append`, `GET|POST|DELETE /api/allowlist`, `GET|POST|DELETE /api/bypass`, `GET /api/export`, `POST /api/import`, `POST /api/broken-report`; `GET /` + assets → `public/dashboard`.
- **CSRF / DNS-rebinding defense** (review must_fix — loopback binding is NOT a security boundary): every **mutating** endpoint (`POST /api/settings`, `PUT /api/rules`, `POST /api/rules/append`, allowlist/bypass `POST|DELETE`, `POST /api/import`, `POST /api/broken-report`) MUST (a) require header `X-GhettoBlocker: 1` and reject (403) without it — a simple cross-origin `POST` cannot set a custom header without a preflight the server controls; and (b) validate the `Host` header is exactly `127.0.0.1:<port>` or `localhost:<port>`, rejecting anything else (defeats DNS-rebinding). GET/read endpoints don't mutate, so they don't need the header (but still pass the Host check). The dashboard `fetch` and the extension SW both send `X-GhettoBlocker: 1`.
- **CORS:** echo the request `Origin` only when it is the extension origin (`chrome-extension://<id>`) or a loopback dashboard origin — do NOT blanket `Access-Control-Allow-Origin: *` on mutating endpoints. On `OPTIONS`, reply with the matched origin, allowed methods/headers (incl. `X-GhettoBlocker`), and `Access-Control-Allow-Private-Network: true` when the request carries `Access-Control-Request-Private-Network` (PNA, Risks table).
- **Import safety** (review suggestion): cap `POST /api/import` body size; parse the uploaded rules into a temp engine first and persist only if parsing succeeds; return the imported-rule count so the dashboard can confirm.
- SSE: keep a Set of response streams; `ctx.recordEvent` notifies them. **Evict on disconnect** (review should_fix): register `req.on('close', …)` to delete the stream from the Set, and wrap per-stream writes in try/catch evicting on write error — otherwise EventSource auto-reconnect leaks dead writers in the long-lived tray process. `.unref()` the heartbeat timer.
- Keep `route()` pure/synchronous over the context so it's unit-testable without a live socket.

**Definition of Done:**
- [ ] `GET /api/state` returns settings + summary; `POST /api/settings {paused:true}` (with `X-GhettoBlocker:1`) mutates the context
- [ ] A mutating request **lacking** `X-GhettoBlocker:1`, or with a foreign `Host` header, is rejected with 403
- [ ] `POST /api/rules/append` adds a rule and triggers `setUserRules`
- [ ] `POST /api/import` rejects an oversized/malformed backup without corrupting existing rules; returns imported-rule count on success
- [ ] `OPTIONS` preflight with PNA header returns `Access-Control-Allow-Private-Network: true` and the scoped (not `*`) origin
- [ ] A closed SSE connection is removed from the broadcast set (no leak)
- [ ] Verify: `npx vitest run test/control-server.test.ts`

### Task 5: Dashboard UI (3 themes, all features)

**Objective:** Build the vanilla dashboard served at `/`: tabs Status / Rules / Sites / Stats, a theme switcher (terminal default, glass, synthwave), and all controls — pause/resume, cosmetics + anti-analytics + CSP toggles, rules editor, allowlist + bypass managers, one-click "bypass this site", per-site block-count leaderboard, live activity feed (SSE), import/export (file download/upload), broken-site report form.

**Files:**
- Create: `public/dashboard/index.html`
- Create: `public/dashboard/app.js` (fetch the API, render, SSE wiring, event handlers)
- Create: `public/dashboard/style.css` + `public/dashboard/themes.css` (CSS-variable theming via `:root[data-theme=...]`)
- Create: `public/dashboard/icon.svg` (logo)

**Key Decisions / Notes:**
- Theme = CSS variables swapped by `data-theme` on `<html>`; switcher persists via `POST /api/settings {theme}` and applies instantly.
- Live feed + counters via `EventSource('/api/stats/stream')`; counters animate (count-up) for cool factor.
- Terminal theme: monospace, green/cyan neon, subtle glow/scanline. Glass: frosted panels + gradients. Synthwave: pink/cyan on deep purple.
- All data via the Task 4 API; no inline secrets; no framework. Mutating `fetch` calls send header `X-GhettoBlocker: 1` (Task 4 CSRF gate).

**Definition of Done:**
- [ ] Dashboard loads at `http://127.0.0.1:8081`, all four tabs render
- [ ] Pause toggle, theme switch, add-rule, add-bypass, import/export all hit the API and reflect state (browser-verified — TS-001/002/003/006)
- [ ] Live activity feed updates as requests are blocked
- [ ] Verify: browser automation against a running `npm start` (TS-001, TS-002, TS-003, TS-006)

### Task 6: MV3 picker/zapper extension

**Objective:** Build the build-free MV3 extension: an action popup with "Pick element to block" / "Zap element (this page)" / "Open dashboard" + connection status; a content-script overlay that highlights elements on hover, generates a CSS selector on click, previews `host##selector`, and on confirm sends it to the service worker, which POSTs `/api/rules/append`. "Zap" hides locally without persisting; "Pick" persists.

**Files:**
- Create: `extension/manifest.json` (MV3; `permissions: ["activeTab","scripting","storage"]`, `host_permissions: ["http://127.0.0.1:8081/*"]`, action popup, background SW)
- Create: `extension/background.js` (SW: message handler → `fetch` control server; status ping)
- Create: `extension/content.js` (overlay, hover highlight, click capture, preview/confirm, zap vs pick)
- Create: `extension/selector.js` (compact unique-selector heuristic: id → unique class → `:nth-child` path)
- Create: `extension/popup.html` + `extension/popup.js`
- Create: `extension/icons/` (16/48/128 png)

**Key Decisions / Notes:**
- SW does the cross-origin fetch (has `host_permissions`) — content script never fetches the control server directly (PNA-safe). Communicate via `chrome.runtime.sendMessage`. SW fetches include header `X-GhettoBlocker: 1` (Task 4 CSRF gate).
- Selector heuristic: prefer stable `#id`; else element tag + unique class combo scoped to nearest id ancestor; else positional `:nth-child` chain. Always show a preview + "highlight matches (N)" before save. SHORTCUT: heuristic selector; trigger → swap `@medv/finder` if mis-targeting.
- Rule format saved: `hostnameWithoutPort##selector` (cosmetic hide) so the proxy's cosmetic layer applies it.
- Overlay styled to match the neon theme; ESC cancels.

**Definition of Done:**
- [ ] Loaded unpacked, popup shows connected status when control server is up
- [ ] Picking an element saves a rule that appears in the dashboard and hides the element on reload (TS-005)
- [ ] Verify: browser automation — load page, run picker, confirm rule appears via `GET /api/rules` (TS-005)

### Task 7: Electron app + shared bootstrap

**Objective:** Add the Electron wrapper. Extract a shared `bootstrap()` that loads the engine, builds the `RuntimeContext`, and starts proxy + control server; use it from both the headless entry and Electron main. Electron main adds a system tray (Open Dashboard / Pause / Quit), a dashboard `BrowserWindow` loading `http://127.0.0.1:8081`, single-instance lock, autostart toggle (`app.setLoginItemSettings`), and assisted CA install (detect untrusted CA → button spawns elevated PowerShell via UAC).

**Files:**
- Create: `src/bootstrap.ts` (shared startup → returns `{ ctx, proxy, controlServer, stop() }`)
- Modify: `src/index.ts` (headless entry → use `bootstrap()`; keep quiet logging + stats banner)
- Create: `electron/main.ts` (app lifecycle, tray, window, autostart, CA-install flow, single-instance)
- Create: `electron/tray-icon.png`
- Modify: `scripts/install-ca.ps1` (parameterize CA path so Electron can invoke the same logic as an `extraResource`)

**Key Decisions / Notes:**
- Single-instance lock (`app.requestSingleInstanceLock()`) prevents the EADDRINUSE double-start the headless path warns about (`src/index.ts:15`).
- Window `close` hides to tray (don't quit); Quit from tray menu calls `stop()` then `app.quit()`.
- Autostart toggle persisted in settings and applied via `setLoginItemSettings({ openAtLogin })` — supersedes the Scheduled Task script for the packaged app (script kept for headless users).
- CA install: on launch, check trust (reuse `uninstall-ca.ps1`'s thumbprint-read approach to detect presence); if missing, surface a dashboard banner + a tray/IPC action that runs `powershell Start-Process -Verb RunAs` against the bundled install-ca script.
- **CA private-key handling** (review should_fix): the CA cert+key is generated per-machine on first run under `sslCaDir` (`config.ts:29`) and is NEVER shipped in the installer. The assisted install imports ONLY the public cert (`certs/ca.pem`) into the Windows trust store — the private key is never copied to the trust store, never exposed via any control-API endpoint, and never transmitted. The control server must have no route that returns the key. (Task 8 asserts the key is not among packaged resources.)

**Definition of Done:**
- [ ] `npm run electron:dev` starts the app: tray icon present, clicking Open Dashboard shows the dashboard window
- [ ] `npm start` (headless) still works via shared `bootstrap()`
- [ ] Second launch focuses the existing instance instead of erroring
- [ ] No control-server route returns or exposes the CA private key
- [ ] Verify: `npm run electron:dev` on Windows (manual/launch check) + `npx vitest run` (bootstrap unit smoke if extracted as pure)

### Task 8: Build + packaging (esbuild, electron-builder NSIS) + docs

**Objective:** Wire the build: esbuild compiles our TS (`electron/main.ts` + `src/**`) to `dist/` with node deps **external**; electron-builder packages `dist/` + production `node_modules` + `public/dashboard` + `extension` + `scripts` into a Windows NSIS installer. Add icons and scripts. Update README/docs for the new desktop-app flow, extension install, anti-analytics, and the deferred AdNauseam note.

**Files:**
- Modify: `package.json` (add `electron`, `electron-builder`, `esbuild` devDeps; scripts `build`, `electron:dev`, `dist`; `main: dist/electron-main.cjs`; `build` config block)
- Create: `esbuild.config.mjs` (bundle our TS, deps external, platform node, emit `dist/`)
- Create: `build/icon.ico` + installer assets
- Modify: `README.md` (desktop-app install, dashboard, extension load-unpacked, anti-analytics, redirect feature NOT included)
- Modify: `scripts/update-lists.ts` if engine path handling changed (likely unchanged)

**Key Decisions / Notes:**
- `build.win.target: [{target:"nsis", arch:["x64"]}]`, `nsis: { oneClick:false, perMachine:true, allowToChangeInstallationDirectory:true, runAfterFinish:true }` (confirmed via electron-builder docs).
- Deps external + electron-builder packs `node_modules` → avoids esbuild vs `http-mitm-proxy`/`node-forge` dynamic-require issues (Risks table). No native modules → default asar is fine; no `asarUnpack` needed.
- `extraResources`: `extension/`, `scripts/install-ca.ps1` (so the app can launch the elevated installer); `public/dashboard` either bundled in app or extraResource (served by control server).
- **Never package the CA private key** (review should_fix): the CA lives under `~/.ghetto-blocker/ca/` (a runtime data dir, generated on first run), which is OUTSIDE the packaged tree — confirm no `files`/`extraResources`/asar glob reaches it. `.gitignore` already excludes it from VCS; this just guards the installer.
- Docs: update Project layout, Quick start (installer path), and the QUIC/proxy-flag sections remain valid.

**Definition of Done:**
- [ ] `npm run build` produces `dist/` with a runnable Electron main
- [ ] `npm run dist` produces an NSIS `.exe` installer (Windows) — or, off-Windows, electron-builder validates config and fails only at the Windows-target packaging step (documented)
- [ ] Packaged resource list contains NO CA private key (grep the build manifest / unpacked app for `ca/` key files)
- [ ] README documents the installer flow, extension load, and anti-analytics
- [ ] Verify: `npm run build` exit 0; `npm run typecheck`; `npx vitest run` (full suite)

## Deferred Ideas

- **Full AdNauseam mode** — MV3 extension background-clicks the ads we hide (find ad elements + clickthrough URLs, fire fake clicks), plus a dashboard "ads clicked / noise" vault. Carries detection + click-fraud risk; needs page DOM. Pairs with tracker-cookie ID rotation in the proxy.
- **Privacy-frontend redirects** (LibRedirect-style: YouTube→Invidious etc.) via a user-editable redirect-rule table issuing 302s. (Originally floated as "the redirect thing"; turned out the user meant AdNauseam — captured here in case it's wanted later.)
- **Subresource tracking-param stripping** (currently only main_frame GET navigations).
- **Proxy-side referrer trimming** — only worth adding if targeting a browser/config that does NOT already default to `strict-origin-when-cross-origin`, or to strip full-path *same-origin* referrers the browser keeps. Redundant for the current Chromium runtime.
- **PAC-file passthrough** for bypass hosts (the existing `SHORTCUT` in `src/config.ts:37`).
