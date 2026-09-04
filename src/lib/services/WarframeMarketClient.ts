import { RateLimiter } from './RateLimiter';
import { cache } from './CacheService';
import type { WfmItemFull, WfmItemShort, WfmOrder } from '../types';

/** All endpoint paths are centralised here so they can be swapped if WFM changes its API. */
export const ENDPOINTS = {
  items: () => `/items`,
  item: (slug: string) => `/item/${slug}`,
  itemAlt: (slug: string) => `/items/${slug}`,
  ordersItem: (slug: string) => `/orders/item/${slug}`,
};

export interface ClientOptions {
  base?: string;
  language?: string;
  platform?: string;
  crossplay?: boolean;
  rps?: number;
  timeoutMs?: number;
}

export class WarframeMarketError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

export class WarframeMarketClient {
  readonly base: string;
  language: string;
  platform: string;
  crossplay: boolean;
  private limiter: RateLimiter;
  private timeoutMs: number;
  stats = { requests: 0, errors: 0, rateLimited: 0, lastError: null as string | null };

  constructor(opts: ClientOptions = {}) {
    this.base = opts.base ?? process.env.WFM_API_BASE ?? 'https://api.warframe.market/v2';
    this.language = opts.language ?? process.env.WFM_LANGUAGE ?? 'en';
    this.platform = opts.platform ?? process.env.WFM_PLATFORM ?? 'pc';
    this.crossplay = opts.crossplay ?? (process.env.WFM_CROSSPLAY ?? 'true') === 'true';
    const rps = opts.rps ?? Number(process.env.WFM_RATE_LIMIT_RPS ?? 3);
    this.limiter = new RateLimiter(rps, rps);
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  get pendingRequests() { return this.limiter.pending; }

  private async request<T>(path: string, attempt = 0): Promise<T> {
    await this.limiter.acquire();
    const url = `${this.base}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      this.stats.requests++;
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          Language: this.language,
          Platform: this.platform,
          Crossplay: String(this.crossplay),
          'User-Agent': 'PrimeArbitrageScanner/1.0 (independent open-source tool)',
        },
        cache: 'no-store',
      });
      if (res.status === 429 || res.status === 503 || res.status >= 500) {
        if (res.status === 429) this.stats.rateLimited++;
        if (attempt < 4) {
          const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
          await new Promise((r) => setTimeout(r, backoff));
          return this.request<T>(path, attempt + 1);
        }
        throw new WarframeMarketError(`Upstream error ${res.status}`, res.status);
      }
      if (!res.ok) throw new WarframeMarketError(`HTTP ${res.status} for ${path}`, res.status);
      const json = (await res.json()) as { data: T; error?: unknown };
      return json.data;
    } catch (err) {
      if (err instanceof WarframeMarketError) { this.stats.errors++; this.stats.lastError = err.message; throw err; }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.min(6000, 500 * 2 ** attempt)));
        return this.request<T>(path, attempt + 1);
      }
      this.stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      this.stats.lastError = msg;
      throw new WarframeMarketError(msg);
    }
  }

  getItems() { return this.request<WfmItemShort[]>(ENDPOINTS.items()); }

  async getItem(slug: string): Promise<WfmItemFull> {
    try { return await this.request<WfmItemFull>(ENDPOINTS.item(slug)); }
    catch { return this.request<WfmItemFull>(ENDPOINTS.itemAlt(slug)); }
  }

  getOrders(slug: string) { return this.request<WfmOrder[]>(ENDPOINTS.ordersItem(slug)); }
}

const g = globalThis as unknown as { __wfClient?: WarframeMarketClient };
export const wfm = g.__wfClient ?? (g.__wfClient = new WarframeMarketClient());
export { cache };
