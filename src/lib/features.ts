/**
 * PRO feature gating — configurable so restrictions can change later without
 * touching route code.
 *
 * A feature is either 'free' (everyone) or 'pro' (verified subscription only).
 * Existing scanner functionality that predates accounts stays 'free' unless a
 * deliberate business decision gates it — the Capital Calculator is the only
 * newly PRO-gated feature, plus unlimited searches via the quota system.
 *
 * Override with e.g. FEATURES_capital_calculator=free (env, no restart-free
 * reload needed since it is read per request).
 */
export type FeatureTier = 'free' | 'pro';

export const FEATURES: Record<string, FeatureTier> = {
  // New PRO features
  capital_calculator: 'pro',
  unlimited_searches: 'pro',
  // Existing functionality deliberately left FREE (do not hide what already
  // worked pre-accounts): dashboard, filters, search, detail pages, watchlist,
  // settings, refresh, catalog.
  scanner_dashboard: 'free',
  set_detail: 'free',
  watchlist: 'free',
};

export function featureTier(feature: string): FeatureTier {
  const envKey = `FEATURES_${feature}`.toUpperCase();
  const override = process.env[envKey]?.trim().toLowerCase();
  if (override === 'free' || override === 'pro') return override;
  return FEATURES[feature] ?? 'free';
}

export function featureEnabled(feature: string, isPro: boolean): boolean {
  return featureTier(feature) === 'free' || isPro;
}
