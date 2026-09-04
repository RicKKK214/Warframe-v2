'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayoutDashboard, GitCompareArrows, Radar, Star, Settings2, RefreshCw, Gem } from 'lucide-react';
import { cn, ago } from '@/lib/utils';

const LINKS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/set-vs-parts', label: 'Set vs Parts', icon: GitCompareArrows },
  { href: '/scanner', label: 'Market Scanner', icon: Radar },
  { href: '/watchlist', label: 'Watchlist', icon: Star },
  { href: '/settings', label: 'Settings', icon: Settings2 },
];

interface Status {
  lastRefreshAt: number | null;
  scan: { running: boolean; processed: number; total: number };
  scannedSets: number;
  nextRunAt: number | null;
  refreshSeconds: number;
  parts: { totalParts: number; uniqueParts: number; sets: number };
}

/** mm:ss for a countdown. */
function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Nav() {
  const pathname = usePathname();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  // Ticks every second so the countdown moves smoothly between the 5s status polls,
  // rather than jumping in 5-second steps.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = async () => {
    try {
      const r = await fetch('/api/status');
      if (r.ok) setStatus(await r.json());
    } catch { /* offline */ }
  };

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const refresh = async () => {
    setBusy(true);
    try {
      await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 25 }),
      });
      await load();
      window.dispatchEvent(new CustomEvent('wf:refreshed'));
    } finally { setBusy(false); }
  };

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-void/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-4 px-5 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/15 text-accent2">
            <Gem size={16} />
          </span>
          <span className="text-sm font-semibold tracking-wide text-slate-100">
            PRIME ARBITRAGE <span className="text-accent2">SCANNER</span>
          </span>
        </Link>

        <nav className="flex flex-wrap items-center gap-1">
          {LINKS.map((l) => {
            const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
            const Icon = l.icon;
            return (
              <Link key={l.href} href={l.href}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition',
                  active ? 'bg-accent/15 text-accent2' : 'text-slate-400 hover:bg-panel2 hover:text-slate-200',
                )}>
                <Icon size={15} />{l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div className="text-right text-[11px] leading-tight text-slate-500">
            <div>
              Last market refresh: <span className="text-slate-300">{ago(status?.lastRefreshAt ?? null)}</span>
              {!status?.scan.running && status?.nextRunAt ? (
                <>
                  {' · next in '}
                  <span className="font-mono text-accent2">
                    {mmss((status.nextRunAt - now) / 1000)}
                  </span>
                </>
              ) : null}
            </div>
            <div>
              {status?.scan.running ? (
                <span className="text-accent2">
                  Scanning {status.scan.processed}/{status.scan.total}…
                </span>
              ) : (
                <>
                  {status?.scannedSets ?? 0} sets
                  {status?.parts?.totalParts
                    ? ` · ${status.parts.totalParts} parts (${status.parts.uniqueParts} unique)`
                    : ''}
                  {' cached'}
                </>
              )}
            </div>
          </div>
          <button onClick={refresh} disabled={busy} className="btn-accent">
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>
    </header>
  );
}
