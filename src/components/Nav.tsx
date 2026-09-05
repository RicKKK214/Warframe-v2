'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayoutDashboard, GitCompareArrows, Radar, Star, Settings2, RefreshCw, Gem, Calculator, User as UserIcon, Crown, ShieldCheck } from 'lucide-react';
import { cn, ago } from '@/lib/utils';
import { useAuth } from '@/components/AuthProvider';

const LINKS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/set-vs-parts', label: 'Set vs Parts', icon: GitCompareArrows },
  { href: '/scanner', label: 'Market Scanner', icon: Radar },
  { href: '/capital', label: 'Capital', icon: Calculator, pro: true },
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
  const { me } = useAuth();

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

  const isPro = !!me?.isPro;
  const quota = me?.quota;

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
                <Icon size={15} />
                {l.label}
                {l.pro && !isPro ? (
                  <span className="rounded bg-accent/20 px-1 py-0.5 text-[9px] font-semibold text-accent2">PRO</span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {/* Quota indicator — mirrors server state, never drives it. */}
          {quota?.unlimited ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-accent/50 bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent2">
              <Crown size={11} /> PRO · Unlimited searches
            </span>
          ) : quota ? (
            <Link href="/account?upgrade=pro"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]',
                (quota.remaining ?? 0) > 0
                  ? 'border-edge bg-panel2 text-slate-300 hover:border-accent/40'
                  : 'border-loss/40 bg-loss/10 text-loss',
              )}
              title="Free plan: 5 set searches per day. Upgrade to PRO for unlimited.">
              Free searches: {quota.used}{quota.limit !== null ? ` / ${quota.limit}` : ''} today
            </Link>
          ) : null}

          {me?.authenticated ? (
            <div className="flex items-center gap-1.5">
              {me.isAdmin ? (
                <Link href="/admin"
                  className={cn('flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition',
                    pathname.startsWith('/admin') ? 'bg-accent/15 text-accent2' : 'text-slate-400 hover:bg-panel2 hover:text-slate-200')}
                  title="Admin — accounts">
                  <ShieldCheck size={15} />
                  <span className="hidden sm:inline">Admin</span>
                </Link>
              ) : null}
              <Link href="/account"
                className={cn('flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition',
                  pathname.startsWith('/account') ? 'bg-accent/15 text-accent2' : 'text-slate-400 hover:bg-panel2 hover:text-slate-200')}>
                <UserIcon size={15} />
                <span className="hidden max-w-[140px] truncate sm:inline">{me.email}</span>
                {isPro ? <Crown size={13} className="text-accent2" /> : null}
              </Link>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Link href="/login" className="btn px-2.5 py-1.5 text-xs">Log in</Link>
              <Link href="/signup" className="btn-accent px-2.5 py-1.5 text-xs">Sign up</Link>
            </div>
          )}

          <div className="hidden text-right text-[11px] leading-tight text-slate-500 lg:block">
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
