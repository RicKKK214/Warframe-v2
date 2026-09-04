'use client';
import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Card, Spinner } from '@/components/ui';

interface Settings {
  platform: string; crossplay: boolean; language: string;
  pricingMode: string; refreshSeconds: number; onlineOnly: boolean;
}

interface Status {
  cacheEntries: number;
  persistence?: { ok: boolean; lastError: string | null };
  ephemeralStorage?: boolean;
  uptimeSeconds?: number;
  memoryMb?: number;
  upstream: { base: string; requests: number; errors: number; rateLimited: number; queued: number; lastError: string | null };
}

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [a, b] = await Promise.all([fetch('/api/settings'), fetch('/api/status')]);
      setS((await a.json()).data);
      setStatus(await b.json());
    })();
  }, []);

  const save = async () => {
    if (!s) return;
    setError(null);
    const r = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...s, refreshSeconds: Number(s.refreshSeconds) }),
    });
    const j = await r.json();
    if (!j.ok) { setError(j.error); return; }
    setS(j.data); setSaved(true); setTimeout(() => setSaved(false), 2500);
  };

  if (!s) return <Card className="p-8"><Spinner /></Card>;

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Settings</h1>
      <Card className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Platform
            <select className="input" value={s.platform} onChange={(e) => setS({ ...s, platform: e.target.value })}>
              {['pc', 'ps4', 'xbox', 'switch', 'mobile'].map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Language
            <select className="input" value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })}>
              {['en', 'de', 'fr', 'ru', 'es', 'pt', 'zh', 'ko', 'pl', 'uk'].map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Pricing mode
            <select className="input" value={s.pricingMode} onChange={(e) => setS({ ...s, pricingMode: e.target.value })}>
              <option value="lowest">Lowest online seller</option>
              <option value="median3">Median of lowest 3 online sellers (default)</option>
              <option value="median5">Median of lowest 5 online sellers</option>
              <option value="weighted">Weighted realistic price</option>
            </select>
          </label>
          <label className="space-y-1 text-[11px] uppercase tracking-wider text-slate-400">Background refresh (seconds)
            <input className="input" type="number" min={30} max={3600} value={s.refreshSeconds}
              onChange={(e) => setS({ ...s, refreshSeconds: Number(e.target.value) })} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={s.crossplay} onChange={(e) => setS({ ...s, crossplay: e.target.checked })} />
          Cross-play enabled
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={s.onlineOnly} onChange={(e) => setS({ ...s, onlineOnly: e.target.checked })} />
          Prefer sellers who are currently online / in-game
        </label>
        {error ? <div className="text-xs text-loss">{error}</div> : null}
        <div className="flex items-center gap-3">
          <button className="btn-accent" onClick={save}><Save size={14} /> Save settings</button>
          {saved ? <span className="text-xs text-profit">Saved — order cache cleared.</span> : null}
        </div>
      </Card>

      <Card className="space-y-2 text-xs text-slate-400">
        <div className="text-sm font-medium text-slate-200">Upstream status</div>
        <div>Endpoint base: <span className="font-mono text-slate-300">{status?.upstream.base}</span></div>
        <div>Requests: {status?.upstream.requests ?? 0} · errors: {status?.upstream.errors ?? 0} · 429s: {status?.upstream.rateLimited ?? 0} · queued: {status?.upstream.queued ?? 0}</div>
        <div>Cache entries: {status?.cacheEntries ?? 0}</div>
        {status?.upstream.lastError ? <div className="text-loss">Last error: {status.upstream.lastError}</div> : null}
        <div className="pt-1">
          {status?.persistence && !status.persistence.ok ? (
            <div className="rounded border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-300">
              Storage is unavailable on this instance. The scanner works normally from live
              Warframe.market data, but the watchlist and price history will not be saved.
            </div>
          ) : (
            <div className="rounded border border-edge bg-panel2/50 px-3 py-2 text-[11px] text-slate-400">
              Storage is ephemeral. Watchlist and price history are cleared whenever the
              server restarts; live market data is always re-fetched from Warframe.market.
            </div>
          )}
        </div>
        <p className="pt-2 text-[11px] text-slate-500">
          Uptime {status?.uptimeSeconds ?? 0}s · memory {status?.memoryMb ?? 0} MB.
        </p>
        <p className="pt-2 text-[11px] text-slate-500">
          Requests are queued server-side at ~3 requests/second with exponential backoff on HTTP 429.
          Catalog and set composition are cached for 12 hours; live orders for ~90 seconds.
        </p>
      </Card>
    </div>
  );
}
