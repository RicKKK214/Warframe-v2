import { cache } from './CacheService';
import { wfm } from './WarframeMarketClient';
import { itemCatalog } from './ItemCatalogService';
import type { Category } from '../types';

export const COMPOSITION_TTL_MS = 12 * 60 * 60 * 1000;

export interface CompositionPart {
  id: string;
  slug: string;
  name: string;
  quantity: number;
  thumb: string | null;
}

export interface SetComposition {
  setSlug: string;
  setId: string;
  setName: string;
  category: Category;
  thumb: string | null;
  tradable: boolean;
  parts: CompositionPart[];
}

/**
 * Dynamically resolves set composition using setRoot / setParts / quantityInSet
 * from the Warframe.market item endpoint. No hard-coded part lists.
 */
export class SetCompositionService {
  async getComposition(setSlug: string, force = false): Promise<SetComposition | null> {
    const key = `composition:${setSlug}`;
    if (force) cache.delete(key);
    return cache.wrap(key, COMPOSITION_TTL_MS, async () => {
      const root = await wfm.getItem(setSlug);
      if (!root) return null;
      const byId = await itemCatalog.byId();
      const lang = wfm.language;
      const rootName = root.i18n?.[lang]?.name ?? root.i18n?.en?.name ?? setSlug;
      const partIds = (root.setParts ?? []).filter((id) => id !== root.id);

      const parts: CompositionPart[] = [];
      for (const id of partIds) {
        const cat = byId.get(id);
        const slug = cat?.slug;
        if (!slug) continue;
        // quantityInSet lives on the part's own detail record
        let quantity = 1;
        try {
          const detail = await this.getPartDetail(slug);
          quantity = detail?.quantityInSet && detail.quantityInSet > 0 ? detail.quantityInSet : 1;
          if (detail?.tradable === false) continue;
        } catch {
          quantity = 1;
        }
        parts.push({ id, slug, name: cat.name, quantity, thumb: cat.thumb });
      }

      const catRoot = byId.get(root.id);
      return {
        setSlug,
        setId: root.id,
        setName: rootName,
        category: catRoot?.category ?? 'other',
        thumb: catRoot?.thumb ?? null,
        tradable: root.tradable !== false,
        parts,
      } satisfies SetComposition;
    });
  }

  private getPartDetail(slug: string) {
    return cache.wrap(`itemdetail:${slug}`, COMPOSITION_TTL_MS, () => wfm.getItem(slug));
  }
}

export const setComposition = new SetCompositionService();
