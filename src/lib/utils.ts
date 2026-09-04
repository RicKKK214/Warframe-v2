import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function plat(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${Number(n.toFixed(digits))}p`;
}

export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export const CATEGORY_LABEL: Record<string, string> = {
  warframe: 'Warframe', primary: 'Primary', secondary: 'Secondary', melee: 'Melee',
  sentinel: 'Sentinel', archwing: 'Archwing', companion: 'Companion', other: 'Other',
};

export const STRATEGY_LABEL: Record<string, string> = {
  PARTS_TO_SET: 'BUY PARTS → SELL SET',
  SET_TO_PARTS: 'BUY SET → SELL PARTS',
};
