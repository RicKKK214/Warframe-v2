import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSettings, saveSettings } from '@/lib/services/settings';
import { cache } from '@/lib/services/CacheService';

export const dynamic = 'force-dynamic';

const schema = z.object({
  platform: z.enum(['pc', 'ps4', 'xbox', 'switch', 'mobile']).optional(),
  crossplay: z.boolean().optional(),
  language: z.string().min(2).max(5).optional(),
  pricingMode: z.enum(['lowest', 'median3', 'median5', 'weighted']).optional(),
  refreshSeconds: z.number().int().min(30).max(3600).optional(),
  onlineOnly: z.boolean().optional(),
});

export async function GET() {
  return NextResponse.json({ ok: true, data: await getSettings() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
  }
  const next = await saveSettings(parsed.data);
  cache.clearPrefix('orders:');
  if (parsed.data.language || parsed.data.platform) cache.clearPrefix('catalog:');
  return NextResponse.json({ ok: true, data: next });
}
