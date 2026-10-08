import { buildServer } from './app.js';
import { type Config, ConfigError, loadConfig, secretIsGenerated } from './config.js';
import { pruneAuditLog } from './lib/audit.js';
import { readSetting } from './lib/settings.js';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\nRavelon Sync cannot start:\n  ${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  const { app, db, syncEvents } = await buildServer(config);

  if (secretIsGenerated(config.jwtSecret)) {
    app.log.warn(
      'SYNC_JWT_SECRET is not set. A random one was generated for this process, ' +
        'so every restart signs all clients out. Set it before running this for real.',
    );
  }

  // Housekeeping the deployment would otherwise accumulate forever. Daily is
  // often enough for retention that is measured in months.
  const cleanup = async () => {
    try {
      const platform = await readSetting(db, 'platform');
      await pruneAuditLog(db, platform.auditRetentionDays);
      const now = new Date().toISOString();
      await db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(now);
      await db.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?').run(now);
      await db.prepare('DELETE FROM email_verifications WHERE expires_at < ?').run(now);
      await db.prepare('DELETE FROM mfa_challenges WHERE expires_at < ?').run(now);
      await db.prepare('DELETE FROM desktop_auth_requests WHERE expires_at < ?').run(now);
    } catch (error) {
      app.log.warn({ err: error }, 'scheduled cleanup failed');
    }
  };
  // Also once shortly after boot: a server that is restarted more often than
  // daily, by updates or a container scheduler, would otherwise never reach
  // the interval and keep expired tokens and old audit lines indefinitely.
  const startupCleanup = setTimeout(() => void cleanup(), 60 * 1000);
  startupCleanup.unref();
  const dailyCleanup = setInterval(() => void cleanup(), 24 * 60 * 60 * 1000);
  dailyCleanup.unref();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    void (async () => {
      clearTimeout(startupCleanup);
      clearInterval(dailyCleanup);
      syncEvents.close();
      try {
        await app.close();
        await db.close();
        process.exit(0);
      } catch (error) {
        app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      database: db.dialect,
      webInterface: Boolean(config.webRoot),
      publicUrl: config.publicUrl || '(derived from request)',
    },
    `Ravelon Sync ${config.version} listening on ${config.host}:${config.port}`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Ravelon Sync failed to start: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
