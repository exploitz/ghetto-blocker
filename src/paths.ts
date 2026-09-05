import { homedir } from 'node:os';
import { join } from 'node:path';

/** Base data directory. Override with GHETTO_DATA_DIR env var (used in tests). */
export function dataDir(): string {
  return process.env['GHETTO_DATA_DIR'] ?? join(homedir(), '.ghetto-blocker');
}

/** Path to the persisted settings JSON file. */
export function settingsPath(): string {
  return join(dataDir(), 'settings.json');
}

/** Path to the user-written filter rules (uBO-syntax plain text). */
export function userRulesPath(): string {
  return join(dataDir(), 'user-rules.txt');
}

/** Path to the persisted stats JSON file. */
export function statsPath(): string {
  return join(dataDir(), 'stats.json');
}
