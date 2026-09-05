/**
 * browsers.ts -- find installed Chromium browsers and launch them through the proxy.
 *
 * A browser started without the proxy flag is unfiltered, and a Chromium
 * instance that is already running ignores the flags of a second launch
 * (it just opens a window in the existing process). So launching from here
 * checks for a running instance first and refuses when it was started without
 * the proxy, instead of quietly opening an unfiltered window.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type BrowserId = 'vivaldi' | 'chrome' | 'edge' | 'brave' | 'chromium';

export interface BrowserInfo {
  id: BrowserId;
  name: string;
  /** Executable file name, e.g. vivaldi.exe. */
  exe: string;
  /** Full path of the executable. */
  path: string;
}

/** Whether a browser is running, and if so whether it went through the proxy. */
export type RunningState = 'not-running' | 'proxied' | 'unproxied' | 'unknown';

type Env = Record<string, string | undefined>;

const CANDIDATES: { id: BrowserId; name: string; exe: string; paths: (env: Env) => string[] }[] = [
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    exe: 'vivaldi.exe',
    paths: (env) => [
      join(env['LOCALAPPDATA'] ?? '', 'Vivaldi', 'Application', 'vivaldi.exe'),
      join(env['PROGRAMFILES'] ?? '', 'Vivaldi', 'Application', 'vivaldi.exe'),
    ],
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    exe: 'chrome.exe',
    paths: (env) => [
      join(env['PROGRAMFILES'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    exe: 'msedge.exe',
    paths: (env) => [
      join(env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(env['PROGRAMFILES'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
  },
  {
    id: 'brave',
    name: 'Brave',
    exe: 'brave.exe',
    paths: (env) => [
      join(env['PROGRAMFILES'] ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      join(env['LOCALAPPDATA'] ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    exe: 'chrome.exe',
    paths: (env) => [join(env['LOCALAPPDATA'] ?? '', 'Chromium', 'Application', 'chrome.exe')],
  },
];

/** Installed Chromium browsers, in preference order. Windows only; empty elsewhere. */
export function detectBrowsers(
  env: Env = process.env,
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): BrowserInfo[] {
  if (platform !== 'win32') return [];
  const found: BrowserInfo[] = [];
  for (const c of CANDIDATES) {
    const path = c.paths(env).find((p) => p.length > c.exe.length + 1 && exists(p));
    if (path) found.push({ id: c.id, name: c.name, exe: c.exe, path });
  }
  return found;
}

/** The flags that make a Chromium browser use the proxy. */
export function launchFlags(proxyPort: number): string[] {
  return [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--disable-quic'];
}

/** Is this browser running, and was it started through the proxy? Windows only. */
export function runningState(
  exe: string,
  platform: NodeJS.Platform = process.platform,
  exec: typeof execFile = execFile,
): Promise<RunningState> {
  if (platform !== 'win32') return Promise.resolve('unknown');
  if (!/^[a-z0-9_-]+\.exe$/i.test(exe)) return Promise.resolve('unknown');
  // Command lines of the browser processes (the main one has no --type=).
  const script =
    `Get-CimInstance Win32_Process -Filter "name='${exe}'" | ` +
    `Where-Object { $_.CommandLine -notmatch '--type=' } | ` +
    `ForEach-Object { $_.CommandLine }`;
  return new Promise((resolve) => {
    exec(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('unknown');
        const lines = String(stdout).split(/\r?\n/).filter((l) => l.trim());
        if (lines.length === 0) return resolve('not-running');
        resolve(lines.some((l) => l.includes('--proxy-server=')) ? 'proxied' : 'unproxied');
      },
    );
  });
}

/** Start the browser through the proxy, detached from this process. */
export function launchBrowser(browser: BrowserInfo, proxyPort: number, url?: string): void {
  const args = launchFlags(proxyPort);
  if (url && /^https?:\/\//i.test(url)) args.push(url);
  const child = spawn(browser.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}
