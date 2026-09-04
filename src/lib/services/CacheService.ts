interface Entry<T> { value: T; expires: number; }

/** In-memory TTL cache with single-flight de-duplication (shared across requests). */
export class CacheService {
  private store = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  get<T>(key: string): T | undefined {
    const e = this.store.get(key) as Entry<T> | undefined;
    if (!e) return undefined;
    if (Date.now() > e.expires) { this.store.delete(key); return undefined; }
    return e.value;
  }

  ageMs(key: string, ttlMs: number): number | null {
    const e = this.store.get(key);
    if (!e) return null;
    return ttlMs - (e.expires - Date.now());
  }

  set<T>(key: string, value: T, ttlMs: number) {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  delete(key: string) { this.store.delete(key); }

  clearPrefix(prefix: string) {
    for (const k of Array.from(this.store.keys())) if (k.startsWith(prefix)) this.store.delete(k);
  }

  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const flying = this.inflight.get(key) as Promise<T> | undefined;
    if (flying) return flying;
    const p = fn()
      .then((v) => { this.set(key, v, ttlMs); return v; })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  get size() { return this.store.size; }
}

const g = globalThis as unknown as { __wfCache?: CacheService };
export const cache = g.__wfCache ?? (g.__wfCache = new CacheService());
