import { prisma, withDb } from '../db';
import type { PricingMode } from '../types';

export interface Settings {
  platform: string;
  crossplay: boolean;
  language: string;
  pricingMode: PricingMode;
  refreshSeconds: number;
  onlineOnly: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  platform: process.env.WFM_PLATFORM ?? 'pc',
  crossplay: (process.env.WFM_CROSSPLAY ?? 'true') === 'true',
  language: process.env.WFM_LANGUAGE ?? 'en',
  pricingMode: 'median3',
  refreshSeconds: Number(process.env.REFRESH_INTERVAL_SECONDS ?? 120),
  onlineOnly: true,
};

/** In-memory override so settings survive a DB outage for the life of the process. */
let runtimeSettings: Settings | null = null;

export function getRuntimeSettings(): Settings | null {
  return runtimeSettings;
}

export async function getSettings(): Promise<Settings> {
  // Falls back to env-derived defaults when the ephemeral DB is empty or unavailable.
  return withDb(
    async () => {
      const row = await prisma.appSettings.findUnique({ where: { id: 'default' } });
      if (!row) return runtimeSettings ?? DEFAULT_SETTINGS;
      return {
        platform: row.platform,
        crossplay: row.crossplay,
        language: row.language,
        pricingMode: row.pricingMode as PricingMode,
        refreshSeconds: row.refreshSeconds,
        onlineOnly: row.onlineOnly,
      };
    },
    runtimeSettings ?? DEFAULT_SETTINGS,
    'getSettings',
  );
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  // Also held in memory so settings survive a DB outage for the life of the process.
  runtimeSettings = next;
  await withDb(
    () =>
      prisma.appSettings.upsert({
        where: { id: 'default' },
        create: { id: 'default', ...next },
        update: next,
      }),
    null,
    'saveSettings',
  );
  return next;
}


