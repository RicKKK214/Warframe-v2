import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/tests/setup.ts'],
    // Integration tests boot a real PostgreSQL; keep files sequential-ish but
    // allow parallelism within files (concurrency tests need it).
    fileParallelism: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
