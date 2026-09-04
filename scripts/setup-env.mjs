#!/usr/bin/env node
/**
 * NOTE: Prisma resolves relative SQLite paths from the schema directory (prisma/),
 * so "postgresql://wf:wf@127.0.0.1:5432/wfarb" means prisma/dev.db - not a file at the repo root.
 *
 * Creates .env from .env.example on first run and ensures the SQLite schema exists.
 *
 * Without this, a fresh `git clone` has no .env, so Prisma throws
 * "Environment variable not found: DATABASE_URL" on every query.
 * Runs automatically before `npm run dev`. Never fatal.
 */
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ENV = '.env';
const EXAMPLE = '.env.example';

try {
  if (!existsSync(ENV) && existsSync(EXAMPLE)) {
    copyFileSync(EXAMPLE, ENV);
    console.log(`[setup] created ${ENV} from ${EXAMPLE}`);
  }

  let url = process.env.DATABASE_URL;
  if (!url && existsSync(ENV)) {
    const m = readFileSync(ENV, 'utf8').match(/^\s*DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
    if (m) url = m[1].trim();
  }
  url = url || 'postgresql://wf:wf@127.0.0.1:5432/wfarb';

  // Idempotent: creates the DB file and syncs the schema if needed.
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: url },
  });
  console.log(`[setup] database ready at ${url}`);
} catch {
  console.warn('[setup] could not prepare the database - the app will run without persistence');
}
