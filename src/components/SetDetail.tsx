'use client';
import { useCallback, useEffect, useState } from 'react';
import { Star, RefreshCw, ExternalLink } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Card, Stat, Money, Roi, ConfidenceBadge, StrategyTag, Spinner, ErrorState, EmptyState, Disclaimer } from './ui';
import { ago, plat, STRATEGY_LABEL, CATEGORY_LABEL } from '@/lib/utils';
import type { SetAnalysis } from '@/lib/types';

interface RawOrder {
  platinum: number; quantity: number; user: string; status: string; reputation: number;
}
interface Snapshot {
  createdAt: string; setSellPrice: number | null; partsCost: number | null;
  spread: number | null; bestProfit: number | null;
}
interface Payload {
  analysis: SetAnalysis;
  rawSell: RawOrder[];
  rawBuy: RawOrder[];
  history: Snapshot[];
  excludedSell: number;
  excludedBuy: number;
  watched: boolean;
  pricingMode: string;
}

export function SetDetail({ slug }: { slug: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setError(null);
    try {
      const r = await fetch(`/api/sets/${slug}${refresh ? '?refresh=true' : ''}`);
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j.data as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load set');
    } finally { setLoading(false); setBusy(false); }
  }, [slug]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  const toggleWatch = async () => {
    if (!data) return;
    const r = await fetch('/api/watchlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setSlug: slug, setName: data.analysis.name }),
    });
    const j = await r.json();
    setData({ ...data, watched: !!j.watched });
  };

  if (loading) return <Card className="p-8"><Spinner label="Loading live order book…" /></Card>;
  if (error) return <ErrorState message={error} onRetry={() => { setLoading(true); void load(); }} />;
  if (!data) return <EmptyState title="No data for this set" />;

  const a = data.analysis;
  const p2s = a.strategies.find((s) => s.strategy === 'PARTS_TO_SET')!;
  const s2p = a.strategies.find((s) => s.strategy === 'SET_TO_PARTS')!;
  const best = a.bestStrategy;
  const cheaperOption =
    a.partsCost !== null && a.set.cheapestSell !== null
      ? a.partsCost < a.set.cheapestSell ? 'Parts individually' : 'Complete set'
      : 'Unknown';
  const diff = a.partsCost !== null && a.set.cheapestSell !== null ? a.set.cheapestSell - a.partsCost : null;

  const chart = data.history
    .filter((h) => h.setSellPrice !== null || h.partsCost !== null)
    .map((h) => ({
      t: new Date(h.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      set: h.setSellPrice, parts: h.partsCost, spread: h.spread,
    }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-50">{a.name}</h1>
        <span className="chip">{CATEGORY_LABEL[a.category] ?? a.category}</span>
        <ConfidenceBadge score={a.confidence} label={a.confidenceLabel} />
        <span className="chip">pricing: {data.pricingMode}</span>
        <span className="chip">updated {ago(a.updatedAt)}</span>
        <div className="ml-auto flex gap-2">
          <a className="btn" href={`https://warframe.market/items/${slug}`} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> warframe.market
          </a>
          <button className="btn" onClick={toggleWatch}>
            <Star size={14} className={data.watched ? 'fill-amber-300 text-amber-300' : ''} />
            {data.watched ? 'Watching' : 'Watch'}
          </button>
          <button className="btn-accent" disabled={busy} onClick={() => { setBusy(true); void load(true); }}>
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh orders
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-accent/25">
          <div className="text-xs font-semibold uppercase tracking-widest text-accent2">Complete set</div>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <Stat label="Realistic purchase price" value={plat(a.set.cheapestSell)} sub="cheapest online sell order" />
            <Stat label="Realistic sale price" value={plat(a.set.recommendedSell)} sub="recommended listing price" />
            <Stat label="Sellers" value={a.set.sellers} />
            <Stat label="Buyers" value={a.set.buyers} sub={`best buy ${plat(a.set.bestBuy)}`} />
          </div>
        </Card>
        <Card className="border-sky-400/20">
          <div className="text-xs font-semibold uppercase tracking-widest text-sky-300">All parts</div>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <Stat label="Combined purchase price" value={plat(a.partsCost)} sub={`${a.partCount} components`} />
            <Stat label="Combined sale value" value={plat(a.partsSaleValue)} sub="if listed individually" />
            <Stat label="Instant dump value" value={plat(a.partsInstantValue)} sub="into existing buy orders" />
            <Stat label="Set vs parts difference"
              value={diff === null ? '—' : `${diff > 0 ? '+' : ''}${plat(diff)}`}
              tone={diff !== null && diff > 0 ? 'good' : diff !== null && diff < 0 ? 'bad' : 'neutral'}
              sub={`Cheaper option: ${cheaperOption}`} />
          </div>
        </Card>
      </div>

      <Card className="p-0">
        <div className="border-b border-edge px-4 py-3 text-sm font-medium text-slate-200">
          Required components
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="bg-panel2/60">
              <tr>
                <th className="th">Part</th>
                <th className="th text-right">Qty</th>
                <th className="th text-right">Cheapest sell</th>
                <th className="th text-right">Recommended sell</th>
                <th className="th text-right">Best buy</th>
                <th className="th text-right">Sellers</th>
                <th className="th text-right">Buyers</th>
              </tr>
            </thead>
            <tbody>
              {a.parts.map((p) => (
                <tr key={p.slug} className="border-t border-edge/60">
                  <td className="td">{p.name}</td>
                  <td className="td text-right text-slate-400">×{p.quantity}</td>
                  <td className="td text-right"><Money value={p.cheapestSell} /></td>
                  <td className="td text-right"><Money value={p.recommendedSell} /></td>
                  <td className="td text-right"><Money value={p.bestBuy} /></td>
                  <td className="td text-right text-slate-300">{p.sellers}</td>
                  <td className="td text-right text-slate-300">{p.buyers}</td>
                </tr>
              ))}
              <tr className="border-t border-edge bg-panel2/40 font-medium">
                <td className="td">Parts total</td>
                <td className="td text-right text-slate-400">{a.partCount}</td>
                <td className="td text-right"><Money value={a.partsCost} /></td>
                <td className="td text-right"><Money value={a.partsSaleValue} /></td>
                <td className="td text-right"><Money value={a.partsInstantValue} /></td>
                <td className="td" colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {[p2s, s2p].map((s) => (
          <Card key={s.strategy} className={best?.strategy === s.strategy ? 'border-profit/40' : ''}>
            <div className="flex items-center gap-2">
              <StrategyTag strategy={s.strategy} />
              <span className="text-xs text-slate-400">{STRATEGY_LABEL[s.strategy]}</span>
              {best?.strategy === s.strategy ? (
                <span className="ml-auto rounded-full border border-profit/40 bg-profit/10 px-2 py-0.5 text-[10px] text-profit">
                  Recommended trade
                </span>
              ) : null}
            </div>
            {/* Instant flip leads: it is what a trader can actually realise right now by
                selling into existing buy orders. The listing figures are the optimistic
                case and depend on someone eventually buying, so they come second. */}
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Stat label="Investment" value={plat(s.investment)} />
              <Stat label="Instant revenue" value={plat(s.instantRevenue)} sub="sell into buy orders" />
              <Stat label="Instant profit" value={<Money value={s.instantProfit} signed />} />
              <Stat label="Instant ROI" value={<Roi value={s.instantRoi} />} />
            </div>
            <div className="mt-4 border-t border-slate-800 pt-3">
              <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-500">
                If you list and wait
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Listing revenue" value={plat(s.listingRevenue)} />
                <Stat label="Listing profit" value={<Money value={s.listingProfit} signed />} sub={<Roi value={s.listingRoi} />} />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {chart.length > 1 ? (
        <Card>
          <div className="mb-3 text-sm font-medium text-slate-200">Price history (set vs parts)</div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart}>
                <CartesianGrid stroke="#1f2637" vertical={false} />
                <XAxis dataKey="t" stroke="#64748b" fontSize={11} />
                <YAxis stroke="#64748b" fontSize={11} />
                <Tooltip contentStyle={{ background: '#0d1018', border: '1px solid #1f2637', fontSize: 12 }} />
                <Line type="monotone" dataKey="set" stroke="#a78bfa" dot={false} name="Set price" />
                <Line type="monotone" dataKey="parts" stroke="#38bdf8" dot={false} name="Parts cost" />
                <Line type="monotone" dataKey="spread" stroke="#22c55e" dot={false} name="Spread" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-slate-200">Cheapest set sell listings</span>
            {data.excludedSell > 0 ? (
              <span className="text-[10px] text-slate-500">
                {data.excludedSell} stale/offline order{data.excludedSell === 1 ? '' : 's'} filtered out
              </span>
            ) : null}
          </div>
          <OrderList orders={data.rawSell} empty="No valid sell orders from online sellers" />
        </Card>
        <Card>
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-slate-200">Highest set buy offers</span>
            {data.excludedBuy > 0 ? (
              <span className="text-[10px] text-slate-500">
                {data.excludedBuy} stale/offline order{data.excludedBuy === 1 ? '' : 's'} filtered out
              </span>
            ) : null}
          </div>
          <OrderList orders={data.rawBuy} empty="No valid buy orders from online sellers" />
        </Card>
      </div>

      <Disclaimer />
    </div>
  );
}

function OrderList({ orders, empty }: { orders: RawOrder[]; empty: string }) {
  if (!orders.length) return <div className="text-xs text-slate-500">{empty}</div>;
  return (
    <ul className="space-y-1">
      {orders.map((o, i) => (
        <li key={i} className="flex items-center gap-3 rounded border border-edge/60 px-3 py-1.5 text-xs">
          <span className={`h-2 w-2 rounded-full ${o.status === 'ingame' ? 'bg-profit' : o.status === 'online' ? 'bg-amber-400' : 'bg-slate-600'}`} />
          <span className="text-slate-300">{o.user}</span>
          <span className="text-slate-600">rep {o.reputation}</span>
          <span className="ml-auto font-mono text-plat">{o.platinum}p</span>
          <span className="text-slate-500">×{o.quantity}</span>
        </li>
      ))}
    </ul>
  );
}
