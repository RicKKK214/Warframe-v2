import { NextResponse } from 'next/server';
import { scanner } from '@/lib/services/ScannerService';
import { wfm } from '@/lib/services/WarframeMarketClient';
import { cache } from '@/lib/services/CacheService';
import { getSettings } from '@/lib/services/settings';
import { probeDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await getSettings();
  const persistence = await probeDb();
  const last = scanner.lastRefreshAt;
  return NextResponse.json({
    ok: true,
    lastRefreshAt: last,
    secondsSinceRefresh: last ? Math.round((Date.now() - last) / 1000) : null,
    scan: scanner.state,
    scannedSets: scanner.list().length,
    cacheEntries: cache.size,
    warm: scanner.state.warm,
    coldStart: !scanner.state.warm,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    persistence,
    ephemeralStorage: true,
    upstream: {
      base: wfm.base,
      platform: wfm.platform,
      crossplay: wfm.crossplay,
      language: wfm.language,
      queued: wfm.pendingRequests,
      ...wfm.stats,
    },
    settings,
  });
}
