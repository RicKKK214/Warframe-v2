'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Star, Trash2 } from 'lucide-react';
import { Card, Money, Roi, Spinner, EmptyState, ErrorState, StrategyTag, Disclaimer } from '@/components/ui';
import { ago } from '@/lib/utils';

interface Row {
  setSlug: string; setName: string; strategy: string | null;
  lastProfit: number | null; prevProfit: number | null; lastRoi: number | null; updatedAt: string;
}

export default function WatchlistPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [persistence, setPersistence] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/watchlist');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'Failed');
      setRows(j.data as Row[]);
      setPersistence(j.persistence !== false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const remove = async (slug: string, name: string) => {
    await fetch('/api/watchlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setSlug: slug, setName: name }),
    });
    void load();
  };

  if (loading) return <Card className="p-8"><Spinner /></Card>;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="space-y-4">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
        <Star size={17} className="text-amber-300" /> Watchlist
      </h1>
      <div className={`rounded border px-3 py-2 text-[11px] ${persistence
        ? 'border-edge bg-panel2/50 text-slate-400'
        : 'border-amber-400/40 bg-amber-400/5 text-amber-300'}`}>
        {persistence
          ? 'Storage is ephemeral — the watchlist is cleared when the server restarts.'
          : 'Storage is unavailable on this instance, so the watchlist cannot be saved.'}
      </div>
      {!rows.length ? (
        <EmptyState title="Nothing starred yet"
          hint="Open a set detail page and press Watch to track its profit over time." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[820px]">
            <thead className="bg-panel2/60">
              <tr>
                <th className="th">Set</th>
                <th className="th">Strategy</th>
                <th className="th text-right">Current profit</th>
                <th className="th text-right">Previous profit</th>
                <th className="th text-right">Change</th>
                <th className="th text-right">ROI</th>
                <th className="th">Updated</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const change = r.lastProfit !== null && r.prevProfit !== null ? r.lastProfit - r.prevProfit : null;
                return (
                  <tr key={r.setSlug} className="border-t border-edge/60">
                    <td className="td">
                      <Link className="text-slate-100 hover:text-accent2" href={`/sets/${r.setSlug}`}>{r.setName}</Link>
                    </td>
                    <td className="td">{r.strategy ? <StrategyTag strategy={r.strategy} /> : <span className="text-slate-500">—</span>}</td>
                    <td className="td text-right"><Money value={r.lastProfit} signed /></td>
                    <td className="td text-right"><Money value={r.prevProfit} signed /></td>
                    <td className="td text-right"><Money value={change} signed /></td>
                    <td className="td text-right"><Roi value={r.lastRoi} /></td>
                    <td className="td text-[11px] text-slate-500">{ago(new Date(r.updatedAt).getTime())}</td>
                    <td className="td text-right">
                      <button className="btn" onClick={() => remove(r.setSlug, r.setName)}><Trash2 size={13} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <Disclaimer />
    </div>
  );
}
