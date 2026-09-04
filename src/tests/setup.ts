/**
 * Vitest global setup.
 *
 * Integration tests run against a REAL PostgreSQL (embedded-postgres on
 * linux/mac dev machines; an already-running local PG is reused when present,
 * e.g. the one started via `node tmp/boot-pg.mjs`). The Prisma schema is
 * pushed once per run. Unit tests are unaffected.
 *
 * The production deployment is NOT touched: tests always use 127.0.0.1.
 */
import { execSync } from 'node:child_process';
import net from 'node:net';

const HOST = '127.0.0.1';
const PORT = Number(process.env.TEST_PG_PORT ?? 5433);
const URL = `postgresql://wf:wf@${HOST}:${PORT}/wfarb`;

function portOpen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout: 800 }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function bootEmbeddedPostgres() {
  // Boot our own instance (used when nothing is listening yet).
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pg = new EmbeddedPostgres({
    databaseDir: process.env.TEST_PG_DIR ?? '/tmp/pgdata-vitest',
    user: 'wf',
    password: 'wf',
    port: PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('wfarb').catch(() => undefined);
  console.log(`[test-setup] embedded PostgreSQL ready on ${HOST}:${PORT}`);
}

const g = globalThis as unknown as { __wfTestSetupDone?: boolean };

export async function setup() {
  if (g.__wfTestSetupDone) {
    process.env.DATABASE_URL = URL;
    return;
  }
  g.__wfTestSetupDone = true;
  if (!(await portOpen(PORT, HOST))) {
    await bootEmbeddedPostgres();
  }
  process.env.DATABASE_URL = URL;
  // Stable secrets so signed cookies/IP-hashes are deterministic in tests.
  process.env.AUTH_SECRET ??= 'vitest-auth-secret-do-not-use-in-production';
  // Push the schema (idempotent).
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: URL },
    cwd: process.cwd(),
  });
  console.log('[test-setup] schema pushed');
}

// Vitest setup files execute module side effects; run immediately.
void setup();

export default setup;
