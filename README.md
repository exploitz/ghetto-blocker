# ghetto-blocker

A system-level, uBlock-Origin-style ad/tracker blocker that runs as a **local
HTTPS filtering proxy** instead of a browser extension. It works in any
Chromium browser (Vivaldi, Chrome, Edge, Brave) without relying on Manifest V2,
so it keeps working after Google finishes removing MV2.

It does the two things that make uBlock Origin effective:

1. **Network filtering** -- blocks requests to ad/tracker URLs using the real
   EasyList / EasyPrivacy / uBlock Origin filter lists (via
   [`@ghostery/adblocker`](https://github.com/ghostery/adblocker)).
2. **Cosmetic filtering** -- injects element-hiding CSS (and scriptlets) into
   HTML pages so leftover ad boxes and placeholders disappear, including
   first-party ads that a DNS blocker can't touch. The proxy scans each page for
   the classes/ids/links it contains and injects the matching generic rules
   (the ~28,000 class/id-indexed EasyList rules, not just the hostname ones);
   the companion extension then keeps hiding elements that JavaScript inserts
   later and evaluates procedural rules such as `:has-text()`.
3. **Anti-analytics** -- strips tracking query parameters (`utm_*`, `gclid`,
   `fbclid`, etc.) from GET navigations via a 302 redirect before they reach the
   server.
4. **Element picker** -- the same MV3 extension lets you click any page
   element to create a persistent hide rule stored via the local API.
5. **AdNauseam mode** (off by default) -- instead of blocking ads, let them
   load hidden and click them in the background so the ad networks' profile
   of you fills with noise. Trackers stay blocked. Everything clicked lands in
   the dashboard's Vault.

## How it works

```
  Vivaldi  --HTTP/HTTPS-->  ghetto-blocker proxy (127.0.0.1:8080)  -->  internet
                                  |
                                  +-- @ghostery/adblocker engine
                                      - match(request)  -> block / redirect / allow
                                      - getCosmeticsFilters(page) -> CSS + scriptlets
                                  |
                            control server (127.0.0.1:8081)
                                  |
                                  +-- Dashboard (pause/resume, rules, stats)
                                  +-- REST API  (extension popup + picker)
                                  +-- POST /api/cosmetics  (extension content
                                      script: new DOM classes/ids -> hide CSS)
```

The proxy generates its own Certificate Authority on first run. Once you trust
that CA in Windows, the proxy can decrypt HTTPS, apply filter rules to each
request, and inject cosmetic CSS into HTML responses before handing them to the
browser.

> Chromium ignores certificate **key-pinning** for user-installed root CAs by
> design, so normal browsing through the proxy works. Cert-pinned standalone
> apps are the exception -- see [Bypassing specific sites](#bypassing-specific-sites).

## Requirements

- **Windows 10/11 x64** (NSIS installer path) or Node.js 20+ for headless mode.
- Vivaldi (or any Chromium browser).

---

## Installation

### Option A -- Desktop app (recommended)

1. Build the installer on Windows (`npm install`, then `npm run dist`; it lands
   in `release\ghetto-blocker Setup 0.1.0.exe`) and run it. The NSIS installer
   needs Windows or Wine. From Linux/WSL two wine-free variants work instead:
   `npx electron-builder --win portable` produces a single-file
   `release/ghetto-blocker 0.1.0.exe` (self-extracting, no install step), and
   `npx electron-builder --win dir` produces the unpacked folder
   `release/win-unpacked/` (run `ghetto-blocker.exe` inside it).
2. ghetto-blocker starts in the system tray.  If the CA is not trusted,
   a notification appears -- click it (or right-click tray -> "Install CA
   certificate...") to elevate and import the cert automatically.
3. Launch Vivaldi with the proxy flags (see step 5 below).

### Option B -- Headless / developer install

```powershell
# 1. Install Node dependencies
npm install

# 2. Start the proxy once to generate the CA, then stop it (Ctrl+C)
npm start
#    Note the CA path it prints:  %USERPROFILE%\.ghetto-blocker\ca\certs\ca.pem

# 3. Trust the CA (ELEVATED PowerShell -- right-click "Run as administrator")
powershell -ExecutionPolicy Bypass -File scripts\install-ca.ps1

# 4. Start the proxy and leave it running
npm start
#    Dashboard: http://127.0.0.1:8081
```

---

### Point Vivaldi at the proxy

**Recommended (per-browser):** launch Vivaldi with a proxy flag.  This confines
interception to Vivaldi so the proxy only ever sees browser traffic.

```powershell
& "$env:LOCALAPPDATA\Vivaldi\Application\vivaldi.exe" `
  --proxy-server="http://127.0.0.1:8080" `
  --proxy-bypass-list="<-loopback>"
```

> **Avoid the system-wide proxy** (Windows Settings -> Network & Internet ->
> Proxy). It funnels *every* app through the blocker -- AnyDesk, Windows
> connectivity probes, Google push, password managers -- and those non-HTTP
> protocols can't go through an HTTP proxy. Per-browser scoping avoids all of
> it. `--proxy-bypass-list="<-loopback>"` also stops the browser from trying to
> proxy `localhost` back through the proxy.

### Disable QUIC (important)

Chromium does HTTP/3 over QUIC (UDP), which a TCP proxy can't see.  Turn it off
so traffic falls back to interceptable TCP:

- Open `vivaldi://flags`, find **Experimental QUIC protocol**, set it to
  **Disabled**, and relaunch.

### Verify it works

Browse normally. Ad-heavy pages should load cleaner. To confirm from a terminal:

```bash
CA="$USERPROFILE/.ghetto-blocker/ca/certs/ca.pem"   # adjust path for your shell
curl -x http://127.0.0.1:8080 --cacert "$CA" -o /dev/null -w "%{http_code} %{size_download}\n" \
  https://www.google-analytics.com/analytics.js
# -> 200 0   (blocked: zero bytes returned)
```

---

## Dashboard

The local dashboard runs at `http://127.0.0.1:8081` (or open it from the tray
menu -- "Open Dashboard").

| View | Features |
|------|----------|
| **Rail** (always visible) | Active/paused badge; Pause/Resume; cosmetics / anti-tracking / strip-CSP / start-at-login / AdNauseam toggles; view navigation; filter-list age with an **Update lists** button; theme selector |
| **Overview** | All-time blocked / pages cleaned / trackers stripped / allowed / ads clicked counters (persisted across restarts); live 60-second activity graph; filterable live feed; top blocked sites; bypass-a-site and broken-site report |
| **Rules** | Full-height editor for custom filter rules (uBlock Origin / Adblock Plus syntax) with rule count; save, export, import backup |
| **Sites** | Allowlist (no filtering) and bypass hosts (no HTTPS interception) side by side |
| **Vault** | Every ad AdNauseam clicked: time, ad network, page, click-through URL |

Settings (theme, pause state, toggles) persist across restarts.

Themes: **Terminal** (green phosphor), **Cyberpunk** (neon HUD: chamfered
panels, scanlines, grid horizon), and **Daylight** (light). The desktop
window's title bar follows the theme.

---

## Extension: dynamic cosmetics + element picker

The `extension/` directory contains an MV3 browser extension that does two
things:

- **Dynamic cosmetic filtering** (`cosmetics.js`, runs in every http(s) frame).
  The proxy can only see the HTML a server sends; ad slots that JavaScript
  creates afterwards (lazy-loaded units, SPA views, "Advertisement" labels) are
  invisible to it. The content script watches the DOM, reports every new
  class/id/href to the control server, and applies the hide rules those unlock
  as a user-origin stylesheet (so page CSP cannot block it). It also evaluates
  the procedural rules -- `:has-text()`, `:upward()`, nested `:has()` -- that
  plain CSS cannot express. Without the extension you still get network
  blocking plus the cosmetics for whatever was in the served HTML.
- **Element picker / zapper** -- click any page element to block it.
- **Per-tab badge and per-site controls** -- the toolbar icon shows how many
  requests the proxy blocked on the current page (the proxy marks every blocked
  response with an `x-ghetto-blocker` header the extension counts per tab). The
  popup can allow / un-allow the current site and pause / resume all blocking.
- **AdNauseam clicks** -- when the mode is on, the content script reports the
  click-through links of ads it finds (known ad-network click trackers, and any
  outbound link inside an ad-network frame); the service worker announces each
  one to the control server and fetches it after a random 2-20 s delay, at
  most 8 per minute.

`extension/cosmetics.js` is generated by `npm run build` (from
`extension-src/cosmetics.ts`); the installer ships it prebuilt.

### Load unpacked

1. Open `vivaldi://extensions` (or `chrome://extensions`), enable **Developer
   mode** (top-right toggle).
2. Click **Load unpacked** and select the `extension/` folder inside the
   ghetto-blocker install (for the installer path, it is at
   `%LOCALAPPDATA%\Programs\ghetto-blocker\resources\extension\`).
   Run `npm run build` first when loading from a source checkout.
3. The "GB" icon appears in the toolbar.

> The extension asks for access to all http/https sites -- that is what lets it
> apply hide rules on every page. It only ever talks to `127.0.0.1:8081`.

> The browser must be launched with
> `--proxy-bypass-list="<-loopback>"` so the extension can reach the control
> server at `127.0.0.1:8081` directly (loopback bypasses the proxy).

### Using the picker

- **Pick element to block** -- hover highlights elements; click to preview the
  generated CSS selector and match count; confirm to save a persistent hide rule.
  The rule is stored via `POST /api/rules/append` and applied on the next page
  load.
- **Zap element (this page)** -- click to hide immediately; not persisted;
  useful for one-off page cleanup.
- **Open dashboard** -- opens the dashboard tab.

The connection status dot in the popup turns green when the control server is
reachable.

---

## AdNauseam mode

Turn it on with the **AdNauseam** toggle in the dashboard rail. What changes:

- The proxy stops blocking ad-network requests and only enforces the tracker
  lists (EasyPrivacy + uBlock privacy) plus your own rules. Ads load but stay
  hidden by the cosmetic rules, so pages look the same.
- The extension hunts for the hidden ads' click-through links and clicks them
  in the background (`fetch` with `no-cors`, cookies included, so the ad
  network counts a real click). Each click is announced to the control server
  first (`POST /api/adnauseam/click`), which tells the proxy to let that exact
  URL through untouched -- no tracking-param stripping, no filtering.
- Every click is recorded: the "ads clicked" counter, a CLICK entry in the live
  feed, and the **Vault** view.

Pages use more bandwidth in this mode because the ads actually download.

## Updates

The desktop app updates itself from GitHub Releases
(`exploitz/ghetto-blocker`, configured under `build.publish` in
`package.json`). On launch and every 6 hours it checks for a newer release,
downloads it in the background, and offers "Restart to update" in the tray and
in the dashboard rail (which also shows the running version and the last check
result). The update installs on the next quit either way.

Publishing a release (maintainer):

```powershell
# bump "version" in package.json, then, with a GitHub token that can write releases:
$env:GH_TOKEN = "<token>"
npm run release        # build, create the GitHub release, upload installer + latest.yml + blockmap
```

`scripts/release.mjs` creates the release `v<version>` first (electron-builder
races itself when it creates the release from two artifacts at once), runs
electron-builder with `--publish always`, then verifies `latest.yml` and the
blockmap are attached with the names electron-updater expects, uploading them
itself if not. Installed apps pick the release up on their next check.

## Anti-analytics

When **Anti-analytics** is enabled in the dashboard (on by default), GET
navigations that carry tracking query parameters are intercepted and 302-
redirected to the clean URL before the request leaves the machine:

```
GET http://example.com/?id=5&utm_source=newsletter&gclid=abc
 -> 302 http://example.com/?id=5
```

Stripped families: `utm_*`, `gclid`, `fbclid`, `msclkid`, `dclid`, `gbraid`,
`wbraid`, `mc_eid`, `igshid`, `_hsenc`, `_hsmi`, `yclid`, `ttclid`.

Every GET request is covered, subresources (pixels, beacons) included. POST
requests are never modified -- doing so would silently drop the body and break
form submissions.

---

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm start` | Run headless (proxy + control server via `tsx`). |
| `npm run dev` | Run with auto-restart on file changes. |
| `npm test` | Run the Vitest suite (unit + integration tests). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | esbuild: `electron/main.ts` -> `dist/electron-main.cjs`, and `extension-src/cosmetics.ts` -> `extension/cosmetics.js`. |
| `npm run electron:dev` | Build then launch Electron (Windows). |
| `npm run dist` | Build then run electron-builder to produce the NSIS installer in `release/` (Windows). |
| `npm run release` | Same, then publish the installer + `latest.yml` to GitHub Releases (needs `GH_TOKEN`). |
| `npm run update-lists` | Delete the cached engine so the next start re-downloads fresh filter lists. |

---

## Configuration

Runtime settings (pause, cosmetics, anti-analytics, theme, port, allowlist,
bypass hosts) are changed via the **Dashboard** and persist automatically.

Static install-level config lives in `src/config.ts`:

| Field | Default | Meaning |
|-------|---------|---------|
| `proxyPort` | `8080` | Port the MITM proxy listens on. |
| `proxyHost` | `127.0.0.1` | Bind address (local-only). |
| `enginePath` | `~/.ghetto-blocker/engine.bin` | Cached compiled filter engine. |
| `privacyEnginePath` | `~/.ghetto-blocker/privacy.bin` | Cached tracker-lists-only engine (AdNauseam mode). |
| `engineTtlMs` | 7 days | Re-download lists when the cache is older than this; the dashboard's **Update lists** button refreshes on demand. |

Set the `GHETTO_DATA_DIR` environment variable to relocate the whole data
directory (CA, cached engine, settings, user rules) -- useful for running a
second instance or tests.

### Bypassing specific sites

Sites that break due to certificate pinning can be added via the **Dashboard ->
Stats -> Bypass hosts** editor, or manually in the dashboard's Settings panel.
Matching is by exact host or subdomain suffix (`chase.com` covers
`secure.chase.com`).

## Autostart at logon

- **Desktop app:** toggle "Start at login" in the dashboard (persists in
  `settings.json` and is applied via `app.setLoginItemSettings`).
- **Headless:** `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`
  (installs a Windows Scheduled Task). Remove with
  `Unregister-ScheduledTask -TaskName 'ghetto-blocker' -Confirm:$false`.

---

## Security and trust

- **The CA is powerful.** Anything that trusts this CA can have its HTTPS traffic
  decrypted by this proxy. The CA private key lives at
  `%USERPROFILE%\.ghetto-blocker\ca\` -- keep it private and never commit it.
  Run `scripts\uninstall-ca.ps1` to remove the CA from the trust store when
  done, or right-click the tray icon -> Quit, then re-run the uninstall script.
- **CA private key is never shipped.** The installer packages only the app
  binaries; the CA is generated per-machine on first run and lives entirely
  outside the install tree. No control-server route exposes the key.
- **`stripCSP` weakens page XSS protection.** Removing Content-Security-Policy is
  what lets the injected inline CSS/JS run. Acceptable for a personal blocker;
  disable it in the dashboard if you'd rather keep CSP and lose some cosmetic
  filtering.
- **Control server is loopback-only.** The API listens on `127.0.0.1:8081` and
  requires a `X-GhettoBlocker: 1` header and a valid `Host` header on all
  mutating requests (CSRF/DNS-rebinding guard).

---

## Limitations (known shortcuts)

These are deliberate v1 simplifications, each marked with a `SHORTCUT:` comment
in the code naming its upgrade trigger:

- **No per-host TLS passthrough tunnel.** Bypassed hosts are filtered out
  entirely rather than tunneled raw. Upgrade: serve a PAC file returning `DIRECT`
  for bypass hosts.
- **Heuristic element picker selector.** The extension uses an id -> class ->
  `:nth-child` heuristic to generate CSS selectors. If it mis-targets: swap in
  `@medv/finder`.
- **Decode-failure fallback.** If decoding a compressed body fails (rare for
  valid responses), the page is passed through without cosmetics.
- **Cosmetics for JS-inserted content need the extension.** The proxy only
  sees served HTML; see the extension section above.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Browser shows certificate errors | CA not trusted, or Vivaldi was not fully restarted. Re-run the CA install, quit Vivaldi via Task Manager, reopen. |
| Some ads still get through | Lists may be stale (`npm run update-lists`) or served first-party in a way no list covers yet. |
| Ad boxes appear a moment after the page loads | Those are inserted by JavaScript; load the extension (its popup dot must be green) so the dynamic cosmetic layer can hide them. |
| A site won't load at all | Likely cert pinning. Add its host via Dashboard -> Stats -> Bypass hosts and restart the proxy. |
| YouTube/HTTPS still shows ads | Confirm QUIC is disabled (`vivaldi://flags`) -- otherwise that traffic bypasses the proxy. |
| Extension picker shows "Offline" | Ensure ghetto-blocker is running and Vivaldi was launched with `--proxy-bypass-list="<-loopback>"`. |

---

## Project layout

```
src/
  config.ts          Static install config (ports, paths, TTL)
  state.ts           Settings / Stats persistence (all-time totals + AdNauseam vault)
  paths.ts           Data-directory helpers
  runtime.ts         RuntimeContext: live settings, base/privacy/user engines,
                     list updates, AdNauseam pending clicks
  util.ts            Pure helpers (URL, decompress, cosmetic inject, strip params)
  engine.ts          Loads, caches and rebuilds the full + privacy-only engines
  proxy.ts           MITM proxy: block, inject cosmetics, anti-analytics 302
  control-server.ts  Local HTTP API (+ /api/cosmetics) + SSE + static dashboard server
  bootstrap.ts       Shared startup (used by index.ts and electron/main.ts)
  index.ts           Headless entry point
  api-types.ts       Shared TypeScript API types

electron/
  main.ts            Electron main process (tray, window, CA install, autostart)
  tray-icon.png      System tray icon (16x16 neon green)

extension-src/
  cosmetics.ts       Source of the dynamic-cosmetics content script (bundled by esbuild)
  adfinder.ts        Ad click-through link detection for AdNauseam mode

extension/           MV3 extension: dynamic cosmetics + element picker (load unpacked)
  manifest.json
  background.js      Service worker: control-server calls, insertCSS, per-tab badge,
                     popup actions, AdNauseam click scheduler, picker injection
  cosmetics.js       GENERATED by `npm run build` -- DOM monitor + procedural rule evaluator
  content.js         Picker / zapper overlay (injected on demand)
  selector.js        CSS-selector heuristic (id -> class -> :nth-child)
  popup.html / .js   Extension popup
  icons/             16 / 48 / 128 px PNG icons

public/dashboard/    Static dashboard served by the control server
  index.html         4-tab dashboard (Status / Rules / Sites / Stats)
  app.js             Client-side logic (tabs, SSE, API calls)
  style.css / themes.css

scripts/
  install-ca.ps1          Trust the CA (Windows, requires admin)
  uninstall-ca.ps1        Remove the CA from trust store
  install-autostart.ps1   Headless autostart via Windows Scheduled Task
  update-lists.ts         Drop the cached engines (triggers re-download)
  release.mjs             Publish the current version to GitHub Releases

build/
  icon.ico           Multi-size ICO for the NSIS installer

esbuild.config.mjs   Compiles electron/main.ts -> dist/electron-main.cjs and
                     extension-src/cosmetics.ts -> extension/cosmetics.js
release/             electron-builder output (installer / win-unpacked), git-ignored

test/
  util.test.ts         Pure-helper unit tests
  engine.test.ts       Filter matching + cosmetics
  state.test.ts        Settings / stats persistence
  runtime.test.ts      RuntimeContext (two-engine merge, hot reload)
  control-server.test.ts  API endpoint tests (route() + live SSE)
  integration.test.ts  Real proxy: block, inject, anti-analytics, pause
```

## Deferred features

- **Privacy-frontend redirects** (YouTube -> Invidious, etc.).
