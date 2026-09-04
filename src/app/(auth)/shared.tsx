'use client';
import Link from 'next/link';
import { Gem } from 'lucide-react';
import type { ReactNode } from 'react';

/** Shared shell for auth pages — keeps the dark/purple scanner aesthetic. */
export function AuthShell({ title, subtitle, children, footer }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 py-6">
      <div className="text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-accent/15 text-accent2">
          <Gem size={22} />
        </div>
        <h1 className="mt-3 text-xl font-semibold text-slate-50">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-400">{subtitle}</p> : null}
      </div>
      <div className="card p-6">{children}</div>
      {footer ? <div className="text-center text-xs text-slate-500">{footer}</div> : null}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] uppercase tracking-wider text-slate-400">{label}</span>
      {children}
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-loss/40 bg-loss/5 px-3 py-2 text-xs text-loss">{message}</div>
  );
}

export function FormOk({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-profit/40 bg-profit/5 px-3 py-2 text-xs text-profit">{message}</div>
  );
}

export const AuthFooterLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="text-accent2 hover:underline">{children}</Link>
);
