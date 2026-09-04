'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Calculator, Coins, Lock } from 'lucide-react';
import { Card, Stat, Money, Roi, Spinner, ErrorState, EmptyState, Disclaimer, ConfidenceBadge, StrategyTag } from '@/components/ui';
import { useAuth } from '@/components/AuthProvider';

interface Pick {
  slug: string;
  name: string;
  strategy: 'PARTS_TO_SET' | 'SET_TO_PARTS';
  qty: number;
  investment: number;
  revenue: number;
  profit: number;
  roi: number | null;
  perSet: { investment: number | null; profit: number | null; roi: number | null };
  limitedBy: 'supply' | 'demand' | 'capital' | 'margin';
  confidence: number;
  maxBySupply: number;
  maxByDemand: number;
}

interface Result {
  picks: Pick[];
  totals: {
    picks: number; qty: number; investment: number; revenue: number;
    profit: number; roi: number | null; capital: number; remainingPlatinum: number;
  } | null;
  mode: 'instant' | 'listing';
  evaluated: number;
  skippedCold: number;
  pricedFromCache: number;
  lastRefreshAt: number | null;
  note?: string;
  disclaimer: string;
}

const QUICK = [100, 250, 500, 1000, 2000];

export default function CapitalPage() {
  const { me, loading: authLoading } = useAuth();
  const [platinum, setPlatinum] = useState('500');
  const [mode, setMode] = useState<'instant' | 'listing'>('instant');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const p = Number(platinum);
    if (!Number.isFinite(p) || p <= 0) {
      setError('Enter an amount of Platinum (e.g. 500).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/capital-calculator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platinum: p, mode }),
      });
      const j = await r.json();
      if (r.status === 401 || r.status === 403) {
        window.dispatchEvent(new CustomEvent('wf:pro-required', { detail: { feature: 'Capital Calculator' } }));
        setError(j.error ?? 'PRO required.');
        return;
      }
      if (!r.ok || !j.ok) {
        setError(j.error ?? 'Calculation failed.');
        return;
      }
      setResult(j.data as Result);
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }, [platinum, mode]);

  // Run once for signed-in PRO users on first load.
  const ran = useState(() => ({ v: false }))[0];
  useEffect(() => {
    if (!authLoading && me?.isPro && !ran.v) {
      ran.v = true;
      void run();
    }
  }, [authLoading, me, run, ran]);

  if (!authLoading && !me?.isPro) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8">
        <Card className="p-8 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-accent/40 bg-accent/10 text-accent2">
            <Lock size={20} />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-slate-50">Capital Calculator — PRO</h1>
          <p className="mt-2 text-sm text-slate-400">
            Enter your available Platinum and get realistic, quantity-aware flip recommendations
            from live order books — capped by actual seller and buyer quantities, never theoretical
            unlimited supply.
          </p>
          <div className="mt-5 flex flex-col items-center gap-2">
            <Link href="/account?upgrade=pro" className="btn-accent">Get PRO — $6.99/month</Link>
            {me?.authenticated ? null : <a href="/login" className="text-xs text-slate-500 hover:text-accent2">Already PRO? Log in</a>}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
          <Calculator size={18} className="text-accent2" /> Capital Calculator
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Enter your available Platinum. Recommendations use the live scanner data and are capped by
          real order-book quantities — how many sets you can actually buy and sell at qualifying prices.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Available Platinum</span>
            <div className="relative">
              <Coins size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input className="input w-44 pl-9 font-mono" inputMode="numeric" value={platinum}
                onChange={(e) => setPlatinum(e.target.value.replace(/[^0-9]/g, ''))} placeholder="500" />
            </div>
          </label>
          <div className="flex rounded-lg border border-edge bg-panel2 p-0.5">
            <button onClick={() => setMode('instant')}
              className={`rounded px-2.5 py-1.5 text-xs ${mode === 'instant' ? 'bg-accent/20 text-accent2' : 'text-slate-400'}`}>
              Instant flip
            </button>
            <button onClick={() => setMode('listing')}
              className={`rounded px-2.5 py-1.5 text-xs ${mode === 'listing' ? 'bg-accent/20 text-accent2' : 'text-slate-400'}`}>
              Listing flip
            </button>
          </div>
          <button className="btn-accent" onClick={() => void run()} disabled={busy}>
            {busy ? 'Calculating…' : 'Calculate'}
          </button>
          <div className="flex flex-wrap gap-1.5">
            {QUICK.map((q) => (
              <button key={q} className="chip hover:border-accent/50" onClick={() => setPlatinum(String(q))}>
                {q}p
              </button>
            ))}
          </div>
        </div>
        {error ? (
          <div className="mt-3 rounded-lg border border-loss/40 bg-loss/5 px-3 py-2 text-xs text-loss">{error}</div>
        ) : null}
      </Card>

      {busy && !result ? <Card className="p-8"><Spinner label="Pricing order books…" /></Card> : null}
      {!busy && !result && !error ? (
        <EmptyState title="Enter your Platinum and press Calculate"
          hint="Example: with 500p the calculator buys only as many sets as the market and your capital actually allow." />
      ) : null}

      {result?.note ? <Card className="text-sm text-slate-400">{result.note}</Card> : null}

      {result?.totals ? (
        <>
          <Card>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <Stat label="Capital" value={`${Number(platinum)}p`} />
              <Stat label="Invested" value={<Money value={result.totals.investment} />} />
              <Stat label="Expected revenue" value={<Money value={result.totals.revenue} />} />
              <Stat label="Expected profit" value={<Money value={result.totals.profit} signed />} sub={<Roi value={result.totals.roi} />} tone="good" />
              <Stat label="Remaining Platinum" value={<Money value={result.totals.remainingPlatinum} />} />
            </div>
            <div className="mt-3 text-[11px] text-slate-500">
              {result.totals.picks} opportunit{result.totals.picks === 1 ? 'y' : 'ies'} · {result.totals.qty} set{result.totals.qty === 1 ? '' : 's'} ·
              {' '}{result.evaluated} evaluated · {result.skippedCold} skipped (cold data)
            </div>
          </Card>

          {result.picks.length ? (
            <Card className="overflow-x-auto p-0">
              <table className="w-full min-w-[860px]">
                <thead className="bg-panel2/60">
                  <tr>
                    <th className="th">Set</th>
                    <th className="th">Strategy</th>
                    <th className="th text-right">Qty</th>
                    <th className="th text-right">Investment</th>
                    <th className="th text-right">Revenue</th>
                    <th className="th text-right">Profit</th>
                    <th className="th text-right">ROI</th>
                    <th className="th text-right">Per-set profit</th>
                    <th className="th">Limited by</th>
                    <th className="th">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {result.picks.map((p) => (
                    <tr key={p.slug + p.strategy} className="border-t border-edge/60">
                      <td className="td">
                        <Link className="text-slate-100 hover:text-accent2" href={`/sets/${p.slug}`}>{p.name}</Link>
                      </td>
                      <td className="td"><StrategyTag strategy={p.strategy} /></td>
                      <td className="td text-right font-mono text-slate-200">×{p.qty}</td>
                      <td className="td text-right"><Money value={p.investment} /></td>
                      <td className="td text-right"><Money value={p.revenue} /></td>
                      <td className="td text-right"><Money value={p.profit} signed /></td>
                      <td className="td text-right"><Roi value={p.roi} /></td>
                      <td className="td text-right"><Money value={p.perSet.profit} signed /></td>
                      <td className="td text-[11px] text-slate-400">
                        {p.limitedBy === 'supply' ? `Supply (${p.maxBySupply} sets max)`
                          : p.limitedBy === 'demand' ? `Buy demand (${p.maxByDemand})`
                          : p.limitedBy === 'capital' ? 'Your capital'
                          : 'Margin (deeper orders pricier)'}
                      </td>
                      <td className="td"><ConfidenceBadge score={p.confidence} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : (
            <EmptyState title="No realistic opportunities for this capital"
              hint="Nothing was both profitable and executable at current order-book depth. Try a different amount or mode." />
          )}
          <Disclaimer />
        </>
      ) : null}
    </div>
  );
}
