'use client';
import { cn, plat, pct } from '@/lib/utils';
import type { ReactNode } from 'react';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('card p-4', className)}>{children}</div>;
}

export function Stat({ label, value, sub, tone = 'neutral' }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: 'neutral' | 'good' | 'bad' | 'accent';
}) {
  const toneCls = tone === 'good' ? 'text-profit' : tone === 'bad' ? 'text-loss' : tone === 'accent' ? 'text-accent2' : 'text-slate-100';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className={cn('mt-1 font-mono text-xl font-semibold', toneCls)}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

export function Money({ value, signed = false }: { value: number | null | undefined; signed?: boolean }) {
  const v = value ?? null;
  const tone = v === null ? 'text-slate-500' : v > 0 ? 'text-profit' : v < 0 ? 'text-loss' : 'text-slate-300';
  return (
    <span className={cn('font-mono', signed ? tone : 'text-plat')}>
      {v !== null && signed && v > 0 ? '+' : ''}{plat(v)}
    </span>
  );
}

export function Roi({ value }: { value: number | null | undefined }) {
  const v = value ?? null;
  const tone = v === null ? 'text-slate-500' : v > 0 ? 'text-profit' : v < 0 ? 'text-loss' : 'text-slate-300';
  return <span className={cn('font-mono', tone)}>{pct(v)}</span>;
}

export function ConfidenceBadge({ score, label }: { score: number; label?: string }) {
  const l = label ?? (score >= 80 ? 'High' : score >= 55 ? 'Medium' : 'Low');
  const cls = l === 'High' ? 'border-profit/40 bg-profit/10 text-profit'
    : l === 'Medium' ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
    : 'border-loss/40 bg-loss/10 text-loss';
  return <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', cls)}>{l} {score}</span>;
}

export function StrategyTag({ strategy }: { strategy: string }) {
  const parts = strategy === 'PARTS_TO_SET';
  return (
    <span className={cn(
      'whitespace-nowrap rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide',
      parts ? 'border-accent/40 bg-accent/10 text-accent2' : 'border-sky-400/40 bg-sky-400/10 text-sky-300',
    )}>
      {parts ? 'PARTS → SET' : 'SET → PARTS'}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-accent" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge py-16 text-center">
      <div className="text-sm font-medium text-slate-300">{title}</div>
      {hint ? <div className="max-w-md text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-loss/40 bg-loss/5 p-6 text-center">
      <div className="text-sm font-medium text-loss">Something went wrong</div>
      <div className="mt-1 text-xs text-slate-400">{message}</div>
      {onRetry ? <button onClick={onRetry} className="btn mt-4">Retry</button> : null}
    </div>
  );
}

export function Disclaimer() {
  return (
    <p className="text-[11px] leading-relaxed text-slate-500">
      Estimated profit based on current Warframe.market orders. Actual trade results may differ.
      Nothing here is a guaranteed profit — prices can change before a trade executes.
    </p>
  );
}
