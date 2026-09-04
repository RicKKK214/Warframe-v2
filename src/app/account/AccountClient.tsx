'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Crown, LogOut, LogOutIcon, CreditCard, RefreshCw, ShieldCheck, MailWarning, Zap, Calculator,
} from 'lucide-react';
import { Card, Spinner, Disclaimer } from '@/components/ui';
import { useAuth } from '@/components/AuthProvider';

const STATUS_LABEL: Record<string, string> = {
  inactive: 'No active subscription',
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment issue (retrying)',
  canceled: 'Cancelled',
  unpaid: 'Unpaid',
  incomplete: 'Incomplete',
  incomplete_expired: 'Expired',
};

export default function AccountClient() {
  const { me, loading, refresh } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const polls = useRef(0);

  const checkout = params.get('checkout'); // success | cancelled
  const upgrade = params.get('upgrade');

  const startCheckout = async () => {
    setBusy('checkout');
    setError(null);
    try {
      const r = await fetch('/api/billing/checkout', { method: 'POST' });
      const j = await r.json();
      if (j.alreadySubscribed) {
        await refresh();
        return;
      }
      if (!r.ok || !j.ok || !j.url) {
        setError(j.error ?? 'Could not start checkout.');
        return;
      }
      window.location.href = j.url;
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(null);
    }
  };

  const openPortal = async () => {
    setBusy('portal');
    setError(null);
    try {
      const r = await fetch('/api/billing/portal', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok || !j.url) {
        setError(j.error ?? 'Could not open the billing portal.');
        return;
      }
      window.location.href = j.url;
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    await refresh();
    router.push('/');
  };

  const logoutEverywhere = async () => {
    setBusy('logout-all');
    try {
      await fetch('/api/auth/logout-all', { method: 'POST' });
      await refresh();
      router.push('/login');
    } finally {
      setBusy(null);
    }
  };

  const resendVerification = async () => {
    setBusy('verify');
    try {
      const r = await fetch('/api/auth/verify-email', { method: 'POST' });
      const j = await r.json();
      setNotice(r.ok && j.ok ? 'Verification email sent — check your inbox.' : j.error ?? 'Could not send.');
    } finally {
      setBusy(null);
    }
  };

  // After returning from Stripe checkout, poll the server until the webhook
  // lands — the SERVER grants PRO; this page only watches.
  useEffect(() => {
    if (checkout !== 'success') return;
    setNotice('Payment received — confirming your subscription…');
    const t = setInterval(async () => {
      polls.current++;
      const r = await fetch('/api/auth/me?sync=1', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j.isPro) {
          setNotice('PRO is active — enjoy unlimited searches!');
          clearInterval(t);
          void refresh();
        }
      }
      if (polls.current > 20) {
        setNotice('Still confirming… refresh this page in a minute.');
        clearInterval(t);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [checkout, refresh]);

  const upgradeHint = useCallback(() => {
    if (upgrade === 'pro' && me && !me.isPro) {
      return (
        <div className="rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent2">
          Upgrade to PRO for unlimited searches and the Capital Calculator.
          <button className="btn-accent ml-3" onClick={startCheckout} disabled={busy === 'checkout'}>
            {busy === 'checkout' ? 'Redirecting…' : 'Get PRO — $6.99/month'}
          </button>
        </div>
      );
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upgrade, me, busy]);

  if (loading && !me) return <Card className="p-8"><Spinner label="Loading account…" /></Card>;

  if (!me?.authenticated) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-10 text-center">
        <Card className="p-8">
          <h1 className="text-lg font-semibold text-slate-50">You&apos;re not logged in</h1>
          <p className="mt-2 text-sm text-slate-400">Log in or create an account to manage your subscription.</p>
          <div className="mt-5 flex justify-center gap-2">
            <a href="/login" className="btn">Log in</a>
            <a href="/signup" className="btn-accent">Sign up</a>
          </div>
        </Card>
      </div>
    );
  }

  const sub = me.subscription;
  const isPro = me.isPro;
  const periodEnd = sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-50">Account</h1>
        {isPro ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-accent/50 bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent2">
            <Crown size={11} /> PRO
          </span>
        ) : (
          <span className="chip">FREE plan</span>
        )}
        <div className="ml-auto flex gap-2">
          <button className="btn" onClick={logout}><LogOut size={14} /> Log out</button>
          <button className="btn" onClick={logoutEverywhere} disabled={busy === 'logout-all'}>
            <LogOutIcon size={14} /> Log out everywhere
          </button>
        </div>
      </div>

      {upgradeHint()}
      {error ? <div className="rounded-lg border border-loss/40 bg-loss/5 px-3 py-2 text-xs text-loss">{error}</div> : null}
      {notice ? <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-xs text-accent2">{notice}</div> : null}

      <Card className="space-y-3">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Profile</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-400">Email</div>
            <div className="mt-1 text-sm text-slate-100">{me.email}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-400">Email verified</div>
            <div className="mt-1 flex items-center gap-2 text-sm">
              {me.user?.emailVerified ? (
                <span className="inline-flex items-center gap-1 text-profit"><ShieldCheck size={13} /> Verified</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-300">
                  <MailWarning size={13} /> Not verified
                  <button className="btn px-2 py-1 text-[10px]" onClick={resendVerification} disabled={busy === 'verify'}>
                    Resend email
                  </button>
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-400">Member since</div>
            <div className="mt-1 text-sm text-slate-100">
              {me.user ? new Date(me.user.createdAt).toLocaleDateString() : '—'}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-400">Daily set searches</div>
            <div className="mt-1 text-sm">
              {me.quota.unlimited ? (
                <span className="text-accent2">Unlimited (PRO)</span>
              ) : (
                <span className="text-slate-100">
                  {me.quota.used} / {me.quota.limit} used today
                </span>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card className={`space-y-4 ${isPro ? 'border-accent/40' : ''}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Subscription</div>
          <button className="btn px-2 py-1 text-[11px]" onClick={() => void refresh()} title="Re-check with the payment provider">
            <RefreshCw size={12} /> Refresh status
          </button>
        </div>

        {isPro ? (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-400">Plan</div>
                <div className="mt-1 text-sm text-slate-100">PRO — $6.99/month</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-400">Status</div>
                <div className="mt-1 text-sm text-profit">{STATUS_LABEL[sub?.status ?? 'active'] ?? sub?.status}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-400">
                  {sub?.cancelAtPeriodEnd ? 'Ends on' : 'Renews on'}
                </div>
                <div className="mt-1 text-sm text-slate-100">{periodEnd ? periodEnd.toLocaleDateString() : '—'}</div>
              </div>
            </div>
            {sub?.cancelAtPeriodEnd ? (
              <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-xs text-amber-300">
                Subscription cancelled — PRO access continues until the period ends ({periodEnd?.toLocaleDateString()}).
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button className="btn" onClick={openPortal} disabled={busy === 'portal'}>
                <CreditCard size={14} /> {busy === 'portal' ? 'Opening…' : 'Manage billing / cancel'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-400">Plan</div>
                <div className="mt-1 text-sm text-slate-100">FREE — 5 set searches / day</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-400">Status</div>
                <div className="mt-1 text-sm text-slate-400">
                  {sub?.status && sub.status !== 'inactive' ? STATUS_LABEL[sub.status] ?? sub.status : STATUS_LABEL.inactive}
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-100">Upgrade to PRO</div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1"><Zap size={12} className="text-accent2" /> Unlimited set searches</span>
                    <span className="inline-flex items-center gap-1"><Calculator size={12} className="text-accent2" /> Capital Calculator</span>
                    <span>Cancel anytime</span>
                  </div>
                </div>
                <button className="btn-accent" onClick={startCheckout} disabled={busy === 'checkout'}>
                  <Crown size={14} /> {busy === 'checkout' ? 'Redirecting…' : 'Get PRO — $6.99/month'}
                </button>
              </div>
            </div>
            {sub?.status && !['inactive', 'canceled'].includes(sub.status) ? (
              <button className="btn" onClick={openPortal} disabled={busy === 'portal'}>
                <CreditCard size={14} /> Manage billing
              </button>
            ) : null}
          </>
        )}
      </Card>

      <Disclaimer />
    </div>
  );
}
