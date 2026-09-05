import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { installQuietLogging } from './quiet.js';

async function main(): Promise<void> {
  installQuietLogging();

  let version = 'dev';
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    version = pkg.version ?? version;
  } catch {
    /* keep 'dev' */
  }

  let result;
  try {
    result = await bootstrap({ version });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(
        `[fatal] port ${config.proxyPort} is already in use - is ghetto-blocker already running?`,
      );
    } else {
      console.error('[fatal] failed to start:', err);
    }
    process.exit(1);
  }

  const { ctx, stop } = result;
  const csPort = ctx.settings.controlPort;
  const caPath = join(config.sslCaDir, 'certs', 'ca.pem');

  console.log('');
  console.log('  ghetto-blocker is running');
  console.log(`  Proxy:     http://${config.proxyHost}:${config.proxyPort}`);
  console.log(`  Dashboard: http://127.0.0.1:${csPort}`);
  console.log(`  CA cert:   ${caPath}`);
  console.log('');
  console.log('  First time? Install the CA cert into Windows "Trusted Root');
  console.log('  Certification Authorities", point Vivaldi at the proxy, and');
  console.log('  disable QUIC. Exact steps: see README.md.');
  console.log('');

  const statsTimer = setInterval(() => {
    const t = ctx.stats.totals;
    console.log(
      `[stats] blocked=${t.blocked} redirected=${t.redirected} ` +
        `cosmetic=${t.injected} poisoned=${t.poisoned} allowed=${t.allowed}`,
    );
  }, 60_000);
  statsTimer.unref();

  const shutdown = (): void => {
    console.log('\n[proxy] shutting down...');
    clearInterval(statsTimer);
    void stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('[fatal]', err);
  process.exit(1);
});
