# Development

## Running from source

```
npm install
npm start            # headless: proxy + dashboard, no tray icon
npm run dev          # same, restarts on file changes
npm test             # vitest (unit + a real proxy integration test)
npm run typecheck
npm run build        # electron main -> dist/, extension bundle -> extension/cosmetics.js
npm run electron:dev # build, then launch the tray app
npm run dist         # build, then NSIS installer -> release/
npm run update-lists # drop the cached filter engines; next start re-downloads
```

`npm run build` must run before loading the extension from a source checkout,
because `extension/cosmetics.js` is generated.

## Headless install (no tray app)

1. `npm start` once to generate the CA, then stop it.
2. Trust the CA from an elevated PowerShell:
   `powershell -ExecutionPolicy Bypass -File scripts\install-ca.ps1`
3. `npm start` and leave it running. Dashboard: `http://127.0.0.1:8081`.
4. Optional logon task: `scripts\install-autostart.ps1`.
   Remove with `Unregister-ScheduledTask -TaskName 'ghetto-blocker'`.

`scripts\uninstall-ca.ps1` removes the CA from the trust store.

## Data directory

Runtime data lives in `%USERPROFILE%\.ghetto-blocker`:

| | |
|---|---|
| `ca/` | The certificate authority and the leaf certificates it has minted |
| `engine.bin`, `privacy.bin` | Cached filter engines (all lists / tracker lists only) |
| `settings.json` | Dashboard settings |
| `user-rules.txt` | Your filter rules |
| `stats.json` | All-time counters and the AdNauseam vault |

Set `GHETTO_DATA_DIR` to relocate it (the tests do this). Filter lists
refresh when the cache is a week old, or on demand from the dashboard.

Install-level config (ports, cache paths, TTL) is in `src/config.ts`.

## Publishing a release

Releases live on GitHub (`build.publish` in `package.json`); installed apps
check them on launch and every six hours.

1. Bump `version` in `package.json`.
2. On Windows, with `GH_TOKEN` set to a token that can write releases:

   ```
   npm run release
   ```

`scripts/release.mjs` creates the `v<version>` release first (electron-builder
races itself when two artifacts try to create the same release), runs
electron-builder with `--publish always`, then checks that the installer,
`latest.yml` and the blockmap are attached under the names electron-updater
expects, uploading whatever is missing.

The NSIS installer can only be built on Windows (or under Wine). From
Linux/WSL, `npx electron-builder --win dir` or `--win portable` still work.

## Layout

```
src/            proxy, filter engines, control server, state (TypeScript)
electron/       tray app entry point
extension/      MV3 extension (cosmetics.js is generated)
extension-src/  sources for the generated extension bundle
public/dashboard/
scripts/        CA install/uninstall, autostart task, release
test/
```
