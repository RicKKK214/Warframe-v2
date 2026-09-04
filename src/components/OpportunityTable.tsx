'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStickyState } from '@/lib/useStickyState';
import { ArrowUpDown, Search, SlidersHorizontal, Zap, Tag, Save } from 'lucide-react';
import { Money, Roi, ConfidenceBadge, StrategyTag, Spinner, EmptyState, ErrorState, Disclaimer } from './ui';
import { ago, CATEGORY_LABEL, plat } from '@/lib/utils';

export interface Row {
  rank: number; slug: string; name: string; category: string; strategy: string;
  investment: number | null; profit: number | null; roi: number | null; revenue: number | null;
  instantProfit: number | null; instantRoi: number | null;
  listingProfit: number | null; listingRoi: number | null;
  sellers: number; buyers: number; confidence: number; confidenceLabel: string;
  partCount: number; updatedAt: number;
}

interface Filters {
  sort: string; mode: 'listing' | 'instant'; q: string; type: string; strategy: string;
  minProfit: string; minRoi: string; maxInvestment: string; minSellers: string; minBuyers: string;
  minInstantProfit: string; minInstantRoi: string;
  excludeLowLiquidity: boolean;
}

const DEFAULTS: Filters = {
  sort: 'roi', mode: 'instant', q: '', type: 'all', strategy: 'all',
  minProfit: '', minRoi: '', maxInvestment: '', minSellers: '', minBuyers: '',
  minInstantProfit: '', minInstantRoi: '',
  excludeLowLiquidity: false,
};

/**
 * Bumped when the Filters shape or defaults change, so old saved values can't linger.
 * v2: default display mode changed from 'listing' to 'instant'. Without the bump, anyone
 * who had already used the site would keep seeing listing prices from their saved filters.
 */
const FILTERS_STORAGE_KEY = 'wfarb.filters.v2';

export function OpportunityTable({ compact = false, title = 'Top Arbitrage Opportunities' }: {
  compact?: boolean; title?: string;
}) {
  // Persisted: a user's filters stay put across reloads and closing the tab, and only
  // change when they change them.
  const [filters, setFilters, { ready: filtersReady, reset: resetStoredFilters }] =
    useStickyState<Filters>(FILTERS_STORAGE_KEY, DEFAULTS);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    lastRefreshAt: number | null; scanning: boolean; scannedSets: number; coldStart: boolean;
  }>({ lastRefreshAt: null, scanning: false, scannedSets: 0, coldStart: false });
  const [showFilters, setShowFilters] = useState(!compact);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set('sort', filters.sort);
    p.set('mode', filters.mode);
    if (filters.q) p.set('q', filters.q);
    if (filters.type !== 'all') p.set('type', filters.type);
    if (filters.strategy !== 'all') p.set('strategy', filters.strategy);
    for (const k of [
      'minProfit', 'minRoi', 'maxInvestment', 'minSellers', 'minBuyers',
      'minInstantProfit', 'minInstantRoi',
    ] as const) {
      if (filters[k] !== '') p.set(k, filters[k]);
    }
    if (filters.excludeLowLiquidity) p.set('excludeLowLiquidity', 'true');
    return p.toString();
  }, [filters]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const r = await fetch(`/api/opportunities?${query}`, { signal });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setRows(j.data as Row[]);
      setMeta({
        lastRefreshAt: j.lastRefreshAt, scanning: j.scanning,
        scannedSets: j.scannedSets, coldStart: !!j.coldStart,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally { setLoading(false); }
  }, [query]);

  useEffect(() => {
    // Wait for saved filters to load, otherwise the first fetch would use the defaults
    // and briefly show results the user did not ask for.
    if (!filtersReady) return;
    const c = new AbortController();
    setLoading(true);
    const t = setTimeout(() => void load(c.signal), 250);
    return () => { c.abort(); clearTimeout(t); };
  }, [load, filtersReady]);

  useEffect(() => {
    if (!filtersReady) return;
    const h = () => void load();
    window.addEventListener('wf:refreshed', h);
    const poll = setInterval(() => void load(), 30000);
    return () => { window.removeEventListener('wf:refreshed', h); clearInterval(poll); };
  }, [load, filtersReady]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  // How many filters differ from the defaults — drives the "saved" hint and the badge
  // on the Filters button, so persisted values are never silently in effect.
  const activeFilterCount = useMemo(
    () =>
      (Object.keys(DEFAULTS) as Array<keyof Filters>).filter(
        (k) => k !== 'sort' && k !== 'mode' && filters[k] !== DEFAULTS[k],
      ).length,
    [filters],
  );
  const shown = compact ? rows.slice(0, 10) : rows;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
        <span className="chip">{rows.length} opportunities</span>
        <span className="chip">{meta.scannedSets} sets analysed</span>
        {meta.scanning ? <span className="chip text-accent2">scanning…</span> : null}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-lg border border-edge bg-panel2 p-0.5">
            <button onClick={() => set('mode', 'listing')}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${filters.mode === 'listing' ? 'bg-accent/20 text-accent2' : 'text-slate-400'}`}>
              <Tag size={12} /> Listing flip
            </button>
            <button onClick={() => set('mode', 'instant')}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${filters.mode === 'instant' ? 'bg-accent/20 text-accent2' : 'text-slate-400'}`}>
              <Zap size={12} /> Instant flip
            </button>
          </div>
          <button className="btn" onClick={() => setShowFilters((s) => !s)}>
            <SlidersHorizontal size={14} /> Filters
            {/* Saved filters persist across visits, so show a count even when the
                panel is collapsed - otherwise results look wrong for no visible reason. */}
            {activeFilterCount > 0 ? (
              <span className="rounded bg-accent/25 px-1.5 py-0.5 text-[10px] font-medium text-accent2">
                {activeFilterCount}
              </span>
            ) : null}
          </button>
        </div>
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input className="input pl-9" placeholder="Search a set — e.g. Wisp Prime"
          value={filters.q} onChange={(e) => set('q', e.target.value)} />
      </div>

      {showFilters ? (
        <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-4 xl:grid-cols-5">
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Sort by
            <select className="input" value={filters.sort} onChange={(e) => set('sort', e.target.value)}>
              <option value="roi">Highest ROI</option>
              <option value="profit">Highest platinum profit</option>
              <option value="instantProfit">Highest instant profit</option>
              <option value="instantRoi">Highest instant ROI</option>
              <option value="investment">Lowest investment</option>
              <option value="liquidity">Highest liquidity</option>
              <option value="confidence">Confidence</option>
              <option value="name">Set name</option>
            </select>
          </label>
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Type
            <select className="input" value={filters.type} onChange={(e) => set('type', e.target.value)}>
              <option value="all">All</option>
              <option value="warframes">Warframes only</option>
              <option value="weapons">Weapons only</option>
            </select>
          </label>
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Strategy
            <select className="input" value={filters.strategy} onChange={(e) => set('strategy', e.target.value)}>
              <option value="all">Both</option>
              <option value="PARTS_TO_SET">Parts → Set</option>
              <option value="SET_TO_PARTS">Set → Parts</option>
            </select>
          </label>
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Min profit (p)
            <input className="input" type="number" min="0" value={filters.minProfit} onChange={(e) => set('minProfit', e.target.value)} />
          </label>
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Min ROI (%)
            <input className="input" type="number" min="0" value={filters.minRoi} onChange={(e) => set('minRoi', e.target.value)} />
          </label>
          <label
            className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400"
            title="Profit when dumping straight into existing buy orders — a guaranteed-speed sale, usually lower than the listing price."
          >
            <span className="flex items-center gap-1">
              <Zap size={11} className="text-amber-400" /> Min instant profit (p)
            </span>
            <input className="input" type="number" value={filters.minInstantProfit}
              onChange={(e) => set('minInstantProfit', e.target.value)} placeholder="e.g. 10" />
          </label>
          <label
            className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400"
            title="ROI on an instant flip, independent of the Listing/Instant display toggle."
          >
            <span className="flex items-center gap-1">
              <Zap size={11} className="text-amber-400" /> Min instant ROI (%)
            </span>
            <input className="input" type="number" value={filters.minInstantRoi}
              onChange={(e) => set('minInstantRoi', e.target.value)} placeholder="e.g. 15" />
          </label>
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Max investment (p)
            <input className="input" type="number" min="0" value={filters.maxInvestment} onChange={(e) => set('maxInvestment', e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Min sellers
              <input className="input" type="number" min="0" value={filters.minSellers} onChange={(e) => set('minSellers', e.target.value)} />
            </label>
            <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Min buyers
              <input className="input" type="number" min="0" value={filters.minBuyers} onChange={(e) => set('minBuyers', e.target.value)} />
            </label>
          </div>
          <label className="col-span-2 flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={filters.excludeLowLiquidity}
              onChange={(e) => set('excludeLowLiquidity', e.target.checked)} />
            Exclude low-liquidity opportunities
          </label>
          <div className="col-span-2 flex flex-wrap items-center gap-3">
            <button className="btn" onClick={resetStoredFilters}>Reset filters</button>
            {activeFilterCount > 0 ? (
              <span className="flex items-center gap-1 text-[11px] text-slate-500">
                <Save size={11} />
                {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} active — saved on this device
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {meta.coldStart && meta.scanning ? (
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-2 text-xs text-accent2">
          Warming up after a restart — re-fetching live Warframe.market orders. Coverage grows every refresh cycle.
        </div>
      ) : null}

      {loading && !rows.length ? (
        <div className="card p-8"><Spinner label="Fetching live Warframe.market orders (rate-limited)…" /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !shown.length ? (
        <EmptyState
          title={meta.scanning ? 'Scanning Warframe.market…' : 'No profitable opportunities match these filters'}
          hint={meta.scanning
            ? 'The scanner is re-fetching live order books after a restart. Results appear within a few seconds.'
            : 'Try lowering the minimum profit/ROI, switching to Listing flip mode, or hitting Refresh to scan more sets.'} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[1150px] border-collapse">
            <thead className="border-b border-edge bg-panel2/60">
              <tr>
                <th className="th w-12">#</th>
                <th className="th">Set</th>
                <th className="th">Type</th>
                <th className="th">Strategy</th>
                <th className="th text-right">Buy cost</th>
                <th className="th text-right">Expected revenue</th>
                <th className="th text-right">Profit</th>
                <th className="th text-right">ROI %</th>
                <th className="th text-right">Sellers</th>
                <th className="th text-right">Buyers</th>
                <th className="th">Confidence</th>
                <th className="th">Updated</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.slug}-${r.strategy}`} className="border-b border-edge/60 transition hover:bg-panel2/50">
                  <td className="td text-slate-500">{r.rank}</td>
                  <td className="td">
                    <Link href={`/sets/${r.slug}`} className="font-medium text-slate-100 hover:text-accent2">
                      {r.name}
                    </Link>
                    <div className="text-[11px] text-slate-500">{r.partCount} parts</div>
                  </td>
                  <td className="td text-slate-400">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="td"><StrategyTag strategy={r.strategy} /></td>
                  <td className="td text-right"><Money value={r.investment} /></td>
                  <td className="td text-right"><Money value={r.revenue} /></td>
                  <td className="td text-right"><Money value={r.profit} signed /></td>
                  <td className="td text-right"><Roi value={r.roi} /></td>
                  <td className="td text-right text-slate-300">{r.sellers}</td>
                  <td className="td text-right text-slate-300">{r.buyers}</td>
                  <td className="td"><ConfidenceBadge score={r.confidence} label={r.confidenceLabel} /></td>
                  <td className="td text-[11px] text-slate-500">{ago(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Disclaimer />
        <span className="text-[11px] text-slate-500">
          Best single opportunity: {shown[0] ? `${shown[0].name} · ${plat(shown[0].profit)}` : '—'}
        </span>
      </div>
    </section>
  );
}
