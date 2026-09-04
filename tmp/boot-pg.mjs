import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
const pg = new EmbeddedPostgres({
  databaseDir: process.env.PG_DATA_DIR || '/tmp/pgdata-wfarb',
  user: 'wf', password: 'wf', port: Number(process.env.PG_PORT || 5433), persistent: false,
});
await pg.initialise();
await pg.start();
await pg.createDatabase('wfarb').catch(() => {});
console.log('PG ready on port', process.env.PG_PORT || 5433);
// keep alive
setInterval(() => {}, 1 << 30);
