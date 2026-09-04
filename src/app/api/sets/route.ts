import { NextResponse } from 'next/server';
import { itemCatalog } from '@/lib/services/ItemCatalogService';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const category = url.searchParams.get('category');
  try {
    let sets = await itemCatalog.getPrimeSets();
    if (q) sets = sets.filter((s) => s.name.toLowerCase().includes(q));
    if (category && category !== 'all') sets = sets.filter((s) => s.category === category);
    return NextResponse.json({ ok: true, count: sets.length, data: sets });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Catalog unavailable' },
      { status: 502 },
    );
  }
}
