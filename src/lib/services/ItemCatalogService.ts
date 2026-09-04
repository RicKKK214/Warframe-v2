import { cache } from './CacheService';
import { wfm } from './WarframeMarketClient';
import { categoryFromTags } from './ArbitrageEngine';
import type { Category, WfmItemShort } from '../types';

export const CATALOG_TTL_MS = 12 * 60 * 60 * 1000; // 12h (spec: 6-24h)

export interface CatalogEntry {
  id: string;
  slug: string;
  name: string;
  tags: string[];
  thumb: string | null;
  ducats?: number;
  category: Category;
  isPrimeSet: boolean;
}

function toEntry(i: WfmItemShort, lang = 'en'): CatalogEntry {
  const i18n = i.i18n?.[lang] ?? i.i18n?.en ?? {};
  const tags = i.tags ?? [];
  return {
    id: i.id,
    slug: i.slug,
    name: i18n.name ?? i.slug,
    tags,
    thumb: i18n.thumb ? `https://warframe.market/static/assets/${i18n.thumb}` : null,
    ducats: i.ducats,
    category: categoryFromTags(tags),
    isPrimeSet: tags.includes('prime') && tags.includes('set'),
  };
}

export class ItemCatalogService {
  async getCatalog(force = false): Promise<CatalogEntry[]> {
    const key = 'catalog:v2';
    if (force) cache.delete(key);
    return cache.wrap(key, CATALOG_TTL_MS, async () => {
      const items = await wfm.getItems();
      return items.map((i) => toEntry(i, wfm.language));
    });
  }

  async getPrimeSets(force = false): Promise<CatalogEntry[]> {
    const all = await this.getCatalog(force);
    return all.filter((e) => e.isPrimeSet).sort((a, b) => a.name.localeCompare(b.name));
  }

  async bySlug(slug: string): Promise<CatalogEntry | undefined> {
    const all = await this.getCatalog();
    return all.find((e) => e.slug === slug);
  }

  async byId(): Promise<Map<string, CatalogEntry>> {
    const all = await this.getCatalog();
    return new Map(all.map((e) => [e.id, e]));
  }

  async search(q: string, limit = 25): Promise<CatalogEntry[]> {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const all = await this.getCatalog();
    const scored = all
      .filter((e) => e.name.toLowerCase().includes(needle) || e.slug.includes(needle.replace(/\s+/g, '_')))
      .map((e) => ({ e, s: (e.name.toLowerCase().startsWith(needle) ? 0 : 1) + (e.isPrimeSet ? 0 : 0.5) }))
      .sort((a, b) => a.s - b.s || a.e.name.length - b.e.name.length);
    return scored.slice(0, limit).map((x) => x.e);
  }
}

export const itemCatalog = new ItemCatalogService();
