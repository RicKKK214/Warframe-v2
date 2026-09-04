import { NextResponse } from 'next/server';
import { prisma, withDb, dbHealth } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const rows = await withDb(
    () => prisma.watchlist.findMany({ orderBy: { updatedAt: 'desc' } }),
    [],
    'watchlistList',
  );
  return NextResponse.json({ ok: true, data: rows, persistence: dbHealth().ok });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const slug = String(body.setSlug ?? '');
  const name = String(body.setName ?? slug);
  if (!slug) return NextResponse.json({ ok: false, error: 'setSlug required' }, { status: 400 });
  const existing = await withDb(
    () => prisma.watchlist.findUnique({ where: { setSlug: slug } }),
    null,
    'watchlistFind',
  );
  if (existing) {
    await withDb(() => prisma.watchlist.delete({ where: { setSlug: slug } }), null, 'watchlistDelete');
    return NextResponse.json({ ok: true, watched: false, persistence: dbHealth().ok });
  }
  const created = await withDb(
    () => prisma.watchlist.create({ data: { setSlug: slug, setName: name } }),
    null,
    'watchlistCreate',
  );
  if (!created) {
    return NextResponse.json(
      { ok: false, watched: false, error: 'Watchlist unavailable — storage is not writable on this instance.' },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, watched: true, persistence: dbHealth().ok });
}
