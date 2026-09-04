// Prisma resolves env("DATABASE_URL") from schema.prisma when the client is constructed,
// including during `next build` (route collection instantiates modules). Guarantee a value
// so a clone without .env, or a host without the variable set, still builds and runs.
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
  // The database is only a cache, so a missing URL must never break the build or boot.
  // In production use an unreachable placeholder: queries fail fast, withDb() swallows
  // them, and the app runs cache-less rather than pretending a local DB exists.
  if (process.env.NODE_ENV === 'production') {
    process.env.DATABASE_URL = 'postgresql://unset:unset@127.0.0.1:1/unset?connect_timeout=1';
    console.warn(
      '[next.config] DATABASE_URL not set - running without a persistent cache. ' +
        'Set it to a free Neon PostgreSQL URL (https://neon.tech) to make scanned data persist.',
    );
  } else {
    process.env.DATABASE_URL = 'postgresql://wf:wf@127.0.0.1:5432/wfarb';
    console.warn(`[next.config] DATABASE_URL not set - defaulting to ${process.env.DATABASE_URL}`);
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { instrumentationHook: true },
  // Isolate build output per port so a second instance (e.g. a debug/negative-control
  // server) can never corrupt the primary dev server's route manifest.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  images: { remotePatterns: [{ protocol: 'https', hostname: 'warframe.market' }] },
};
export default nextConfig;
