import { NextResponse } from 'next/server';
import { scanner } from '@/lib/services/ScannerService';
import { cache } from '@/lib/services/CacheService';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const limit = typeof body.limit === 'number' ? body.limit : 25;
  const slug = typeof body.slug === 'string' ? body.slug : null;
  try {
    if (slug) {
      cache.delete(`orders:${slug}`);
      const a = await scanner.analyseOne(slug, true);
      return NextResponse.json({ ok: true, refreshed: slug, data: a });
    }
    cache.clearPrefix('orders:');
    const state = await scanner.scan({ limit, force: true });
    return NextResponse.json({ ok: true, state, lastRefreshAt: scanner.lastRefreshAt });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Refresh failed' },
      { status: 502 },
    );
  }
}
