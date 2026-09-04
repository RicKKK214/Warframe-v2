import { NextResponse } from 'next/server';
import { scanner } from '@/lib/services/ScannerService';
import { probeDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Health probe for Render.
 *
 * Deliberately returns 200 as soon as the HTTP server is up — BEFORE the first market
 * scan finishes. The scanner warms in the background, so blocking here would make Render
 * consider a perfectly healthy cold start a failed deploy.
 */
export async function GET() {
  const s = scanner.state;
  // Actively probe so persistence status is accurate, not merely optimistic.
  const persistence = await probeDb();
  return NextResponse.json({
    ok: true,
    status: 'healthy',
    uptimeSeconds: Math.round(process.uptime()),
    scanner: {
      warm: s.warm,
      running: s.running,
      processed: s.processed,
      total: s.total,
      consecutiveFailures: s.consecutiveFailures,
      setsInMemory: scanner.list().length,
      lastError: s.lastError,
      hydratedFromCache: s.hydratedFromCache,
      oldestDataAt: scanner.oldestResultAt(),
    },
    // Persistence is optional; false here does not make the service unhealthy.
    persistence,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
}
