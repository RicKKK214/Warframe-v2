import { NextResponse } from 'next/server';
import { itemCatalog } from '@/lib/services/ItemCatalogService';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  if (!q.trim()) return NextResponse.json({ ok: true, data: [], query: q });
  try {
    const results = await itemCatalog.search(q, 25);
    return NextResponse.json({ ok: true, query: q, data: results });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Search failed' },
      { status: 502 },
    );
  }
}
