/**
 * electron/main.ts -- Electron main process for ghetto-blocker
 *
 * Starts the shared bootstrap (proxy + control server), then creates a system
 * tray icon and a BrowserWindow that loads the local dashboard.  The window
 * hides to tray on close; the app quits only from the tray menu.
 *
 * Single-instance: a second launch focuses the existing window instead of
 * starting a second proxy (which would EADDRINUSE).
 *
 * NOTE: this file is compiled by esbuild (Task 8) and is intentionally
 * outside the main tsconfig.json scope.  Types resolve after `electron` is
 * installed in Task 8.
 */

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  Notification,
  dialog,
  shell,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrap } from '../src/bootstrap.js';
import { config } from '../src/config.js';
import type { BootstrapResult } from '../src/bootstrap.js';

// ---- Single-instance lock -----------------------------------------------
// Prevents EADDRINUSE when the user launches a second copy.

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---- State --------------------------------------------------------------

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let booted: BootstrapResult | null = null;

// ---- Paths (dev vs packaged) --------------------------------------------

/** dev: electron/tray-icon.png relative to dist/electron-main.cjs */
const TRAY_ICON = app.isPackaged
  ? join(process.resourcesPath, 'tray-icon.png')
  : join(__dirname, '..', 'electron', 'tray-icon.png');

/**
 * The CA cert path is the SAME path the proxy generates on first run.
 * Never shipped in the installer; generated at runtime under USERPROFILE.
 */
const CA_PATH = join(
  process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
  '.ghetto-blocker',
  'ca',
  'certs',
  'ca.pem',
);

/** Static dashboard files, bundled as an extraResource (cwd is arbitrary when packaged). */
const DASHBOARD_DIR = app.isPackaged
  ? join(process.resourcesPath, 'public', 'dashboard')
  : join(__dirname, '..', 'public', 'dashboard');

/** install-ca.ps1 bundled as an extraResource so Electron can invoke it. */
const CA_SCRIPT = app.isPackaged
  ? join(process.resourcesPath, 'scripts', 'install-ca.ps1')
  : join(__dirname, '..', 'scripts', 'install-ca.ps1');

// ---- Window chrome ------------------------------------------------------

/** Title bar (and any native popup) follows the dashboard theme. */
function applyWindowTheme(theme: string): void {
  nativeTheme.themeSource = theme === 'daylight' ? 'light' : 'dark';
}

// ---- Self-update (GitHub Releases via electron-updater) -----------------

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function setupAutoUpdate(ctx: BootstrapResult['ctx']): void {
  const { updates } = ctx;
  if (!app.isPackaged) {
    updates.setStatus({ state: 'unavailable', message: 'dev build', version: app.getVersion() });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => updates.setStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    updates.setStatus({ state: 'downloading', version: info.version, message: 'starting download' }),
  );
  autoUpdater.on('download-progress', (p) =>
    updates.setStatus({ state: 'downloading', message: `${Math.round(p.percent)}%` }),
  );
  autoUpdater.on('update-not-available', () =>
    updates.setStatus({ state: 'up-to-date', version: app.getVersion(), checkedAt: Date.now() }),
  );
  autoUpdater.on('update-downloaded', (info) => {
    updates.setStatus({ state: 'ready', version: info.version });
    tray?.setContextMenu(buildTrayMenu());
    if (Notification.isSupported()) {
      new Notification({
        title: 'ghetto-blocker',
        body: `Version ${info.version} is downloaded. Click to restart and install.`,
      })
        .on('click', installUpdate)
        .show();
    }
  });
  autoUpdater.on('error', (err) => updates.setStatus({ state: 'error', message: err.message }));

  updates.check = async () => {
    await autoUpdater.checkForUpdates();
  };
  updates.install = installUpdate;
  updates.setStatus({ state: 'idle', version: app.getVersion() });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => { /* status carries the error */ });
  };
  setTimeout(check, 10_000);
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

function installUpdate(): void {
  void (booted?.stop() ?? Promise.resolve()).finally(() => autoUpdater.quitAndInstall());
}

// ---- CA install helpers -------------------------------------------------

/**
 * Check whether the proxy CA is already in Cert:\LocalMachine\Root.
 * Uses X509Certificate2 to read the thumbprint from the PEM file and
 * look it up in the Windows root store -- same approach as uninstall-ca.ps1.
 */
function isCaTrusted(): Promise<boolean> {
  if (!existsSync(CA_PATH)) return Promise.resolve(false);
  // Escape single quotes in paths for PowerShell
  const safePath = CA_PATH.replace(/'/g, "''");
  const ps = [
    `$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 '${safePath}';`,
    `$found = Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Thumbprint -eq $cert.Thumbprint };`,
    `if ($found) { exit 0 } else { exit 1 }`,
  ].join(' ');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], (err) => {
      resolve(!err);
    });
  });
}

/** Spawn an elevated PowerShell to install the CA (UAC prompt appears). */
function installCa(): void {
  const safeScript = CA_SCRIPT.replace(/'/g, "''");
  const safeCa = CA_PATH.replace(/'/g, "''");
  execFile('powershell', [
    '-Command',
    `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${safeScript}" -CaPath "${safeCa}"'`,
  ]);
}

// ---- Tray ---------------------------------------------------------------

function buildTrayMenu(): ReturnType<typeof Menu.buildFromTemplate> {
  const ctx = booted?.ctx;
  const paused = ctx?.settings.paused ?? false;
  return Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: showDashboard },
    { type: 'separator' },
    {
      label: paused ? 'Resume filtering' : 'Pause filtering',
      click: async () => {
        if (!ctx) return;
        await ctx.updateSettings({ paused: !ctx.settings.paused });
        tray?.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    { label: 'Install CA certificate...', click: installCa },
    ctx?.updates.status.state === 'ready'
      ? { label: `Restart to update to ${ctx.updates.status.version ?? 'new version'}`, click: installUpdate }
      : {
          label: 'Check for updates',
          enabled: !!ctx?.updates.check,
          click: () => {
            ctx?.updates.check?.().catch(() => { /* status carries the error */ });
          },
        },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        void (booted?.stop() ?? Promise.resolve()).finally(() => app.exit(0));
      },
    },
  ]);
}

// ---- Window -------------------------------------------------------------

function showDashboard(): void {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }

  const controlPort = booted?.ctx.settings.controlPort ?? 8081;
  win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 500,
    title: 'ghetto-blocker',
    icon: TRAY_ICON,
    backgroundColor: '#05060a',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false,
  });

  win.loadURL(`http://127.0.0.1:${controlPort}`);
  win.once('ready-to-show', () => win?.show());

  // Hide to tray instead of closing
  win.on('close', (e) => {
    e.preventDefault();
    win?.hide();
  });

  win.on('closed', () => {
    win = null;
  });

  // Open external links in the default browser, not in Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---- App lifecycle ------------------------------------------------------

// When the user tries to start a second instance, focus the existing window.
app.on('second-instance', () => {
  showDashboard();
});

app.whenReady()
  .then(async () => {
    // The dashboard is the whole UI; the default File/Edit/View menu bar is noise.
    Menu.setApplicationMenu(null);
    applyWindowTheme('terminal');

    // Create a placeholder tray so the user knows something is happening.
    const iconImg = nativeImage.createFromPath(TRAY_ICON);
    tray = new Tray(iconImg);
    tray.setToolTip('ghetto-blocker (starting...)');
    tray.setContextMenu(
      Menu.buildFromTemplate([{ label: 'Starting...', enabled: false }]),
    );
    tray.on('double-click', showDashboard);

    // Start the proxy + control server.
    try {
      booted = await bootstrap({ dashboardDir: DASHBOARD_DIR, version: app.getVersion() });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg =
        code === 'EADDRINUSE'
          ? `Port ${config.proxyPort} is already in use.\nIs ghetto-blocker already running?`
          : `Failed to start proxy:\n${String(err)}`;
      dialog.showErrorBox('ghetto-blocker', msg);
      app.exit(1);
      return;
    }

    const controlPort = booted.ctx.settings.controlPort;
    applyWindowTheme(booted.ctx.settings.theme);
    setupAutoUpdate(booted.ctx);
    tray.setToolTip(
      `ghetto-blocker  --  proxy :${config.proxyPort}  dashboard :${controlPort}`,
    );
    tray.setContextMenu(buildTrayMenu());

    // Autostart: apply the stored preference so it survives reinstall, and
    // keep the OS login item + tray menu in sync with dashboard changes.
    app.setLoginItemSettings({
      openAtLogin: booted.ctx.settings.autostart,
    });
    booted.ctx.subscribeSettings((settings) => {
      app.setLoginItemSettings({ openAtLogin: settings.autostart });
      tray?.setContextMenu(buildTrayMenu());
      applyWindowTheme(settings.theme);
    });

    // CA check (best-effort, Windows-only).
    isCaTrusted()
      .then((trusted) => {
        if (!trusted && Notification.isSupported()) {
          new Notification({
            title: 'ghetto-blocker',
            body: 'CA certificate not trusted. Click to install (requires admin).',
          })
            .on('click', installCa)
            .show();
        }
      })
      .catch(() => { /* best-effort */ });
  })
  .catch((err) => {
    dialog.showErrorBox('ghetto-blocker', String(err));
    app.exit(1);
  });

// Stay in tray when all windows are closed.
app.on('window-all-closed', () => {
  // Intentionally empty -- the app lives in the system tray until Quit is clicked.
});
