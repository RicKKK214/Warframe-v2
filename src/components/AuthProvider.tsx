'use client';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';

/**
 * Global client-side auth/quota state.
 *
 * The server is the source of truth: this context only mirrors what
 * /api/auth/me reports (which derives PRO from the database, never from the
 * browser). Client state can be tampered with freely — it only affects what
 * this UI shows, never what the API allows.
 */

export interface QuotaInfo {
  used: number;
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
}

export interface Me {
  authenticated: boolean;
  isPro: boolean;
  isAdmin: boolean;
  email: string | null;
  user: { id: string; email: string; emailVerified: boolean; createdAt: string } | null;
  subscription: {
    plan: string;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    isPro: boolean;
  } | null;
  quota: QuotaInfo;
}

interface AuthContextValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Show the global paywall modal (used when the API returns QUOTA_EXCEEDED). */
  showPaywall: (reason?: string) => void;
  /** Show the global PRO-required modal (PRO-only features for free users). */
  showProRequired: (feature?: string) => void;
}

const DEFAULT_ME: Me = {
  authenticated: false,
  isPro: false,
  isAdmin: false,
  email: null,
  user: null,
  subscription: null,
  quota: { used: 0, limit: 5, remaining: 5, unlimited: false },
};

const AuthContext = createContext<AuthContextValue>({
  me: null,
  loading: true,
  refresh: async () => {},
  showPaywall: () => {},
  showProRequired: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [paywall, setPaywall] = useState<{ open: boolean; reason?: string }>({ open: false });
  const [proRequired, setProRequired] = useState<{ open: boolean; feature?: string }>({ open: false });
  const [needsStorageAccess, setNeedsStorageAccess] = useState(false);
  const refreshing = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    // Coalesce concurrent refreshes (e.g. mount + quota event together).
    if (refreshing.current) return refreshing.current;
    const p = (async () => {
      try {
        const r = await fetch('/api/auth/me', { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          setMe({
            authenticated: !!j.authenticated,
            isPro: !!j.isPro,
            isAdmin: !!j.isAdmin,
            email: j.email ?? null,
            user: j.user ?? null,
            subscription: j.subscription ?? null,
            quota: j.quota ?? DEFAULT_ME.quota,
          });
        }
      } catch {
        /* offline: keep last known state */
      } finally {
        setLoading(false);
        refreshing.current = null;
      }
    })();
    refreshing.current = p;
    return p;
  }, []);

  useEffect(() => {
    void refresh();
    // Embedded-preview support (Storage Access API): when this app runs inside
    // a cross-site iframe, browsers with third-party-cookie blocking refuse to
    // store the session cookie unless the user grants storage access. Detect
    // that situation and offer a one-click grant (needs a user gesture).
    try {
      const d = document as Document & {
        hasStorageAccess?: () => Promise<boolean>;
        requestStorageAccess?: () => Promise<void>;
      };
      if (window.self !== window.top && typeof d.hasStorageAccess === 'function') {
        void d.hasStorageAccess().then((has) => setNeedsStorageAccess(!has)).catch(() => {});
      }
    } catch {
      /* not embedded / API unavailable */
    }
    // Quota changes whenever a set search is charged; search responses emit this.
    const onQuota = () => void refresh();
    const onExceeded = (e: Event) => {
      void refresh();
      const detail = (e as CustomEvent<{ error?: string }>).detail;
      setPaywall({ open: true, reason: detail?.error });
    };
    const onProRequired = (e: Event) => {
      const detail = (e as CustomEvent<{ feature?: string }>).detail;
      setProRequired({ open: true, feature: detail?.feature });
    };
    window.addEventListener('wf:quota', onQuota);
    window.addEventListener('wf:quota-exceeded', onExceeded);
    window.addEventListener('wf:pro-required', onProRequired);
    const t = setInterval(() => void refresh(), 60_000);
    return () => {
      window.removeEventListener('wf:quota', onQuota);
      window.removeEventListener('wf:quota-exceeded', onExceeded);
      window.removeEventListener('wf:pro-required', onProRequired);
      clearInterval(t);
    };
  }, [refresh]);

  const showPaywall = useCallback((reason?: string) => setPaywall({ open: true, reason }), []);
  const showProRequired = useCallback((feature?: string) => setProRequired({ open: true, feature }), []);

  const grantStorageAccess = useCallback(async () => {
    try {
      const d = document as Document & { requestStorageAccess?: () => Promise<void> };
      await d.requestStorageAccess?.();
      setNeedsStorageAccess(false);
      await refresh();
    } catch {
      /* user denied — keep the banner so they can retry or open a new tab */
    }
  }, [refresh]);

  const value = useMemo(
    () => ({ me, loading, refresh, showPaywall, showProRequired }),
    [me, loading, refresh, showPaywall, showProRequired],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {needsStorageAccess ? (
        <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-lg rounded-lg border border-accent/40 bg-void/95 px-4 py-3 text-xs text-slate-300 shadow-xl">
          <span className="font-semibold text-slate-100">Enable login in this embedded preview:</span>{' '}
          your browser blocks session cookies inside embedded frames until you allow access.
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => void grantStorageAccess()} className="btn-accent !px-3 !py-1 text-[11px]">
              Allow cookies for the preview
            </button>
            <a href="/" target="_blank" rel="noreferrer" className="btn !px-3 !py-1 text-[11px]">
              Open in a new tab ↗
            </a>
          </div>
        </div>
      ) : null}
      <PaywallModal
        open={paywall.open}
        reason={paywall.reason}
        onClose={() => setPaywall({ open: false })}
      />
      <ProRequiredModal
        open={proRequired.open}
        feature={proRequired.feature}
        onClose={() => setProRequired({ open: false })}
      />
    </AuthContext.Provider>
  );
}

/** Modal shown when a FREE user has used all daily set searches. */
export function PaywallModal({ open, reason, onClose }: { open: boolean; reason?: string; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-void/80 backdrop-blur-sm" onClick={onClose} />
      <div className="card relative z-10 w-full max-w-md p-6 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-accent/40 bg-accent/10 text-accent2">
          ⚡
        </div>
        <h2 className="mt-4 text-lg font-semibold text-slate-50">Daily free searches used</h2>
        <p className="mt-2 text-sm text-slate-400">
          {reason ?? "You've used all 5 free set searches for today."}
        </p>
        <p className="mt-1 text-sm text-slate-400">
          Create a PRO account for unlimited access.
        </p>
        <div className="mt-5 rounded-lg border border-accent/30 bg-accent/5 p-4">
          <div className="text-2xl font-bold text-accent2">$6.99<span className="text-sm font-normal text-slate-400">/month</span></div>
          <ul className="mt-2 space-y-1 text-left text-xs text-slate-300">
            <li>✓ Unlimited set searches</li>
            <li>✓ Capital Calculator</li>
            <li>✓ Full scanner &amp; opportunity analysis</li>
            <li>✓ Cancel anytime</li>
          </ul>
        </div>
        <div className="mt-5 flex flex-col gap-2">
          <a href="/account?upgrade=pro" className="btn-accent justify-center">Get PRO</a>
          <button className="btn justify-center" onClick={onClose}>Try again tomorrow</button>
        </div>
      </div>
    </div>
  );
}

/** Modal shown when a PRO-only feature is used without a subscription. */
export function ProRequiredModal({ open, feature, onClose }: { open: boolean; feature?: string; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-void/80 backdrop-blur-sm" onClick={onClose} />
      <div className="card relative z-10 w-full max-w-md p-6 text-center">
        <h2 className="text-lg font-semibold text-slate-50">
          {feature ? `${feature} is a PRO feature` : 'PRO feature'}
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Upgrade to PRO ($6.99/month) to unlock the Capital Calculator, unlimited set searches and more.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <a href="/account?upgrade=pro" className="btn-accent justify-center">Get PRO — $6.99/month</a>
          <button className="btn justify-center" onClick={onClose}>Not now</button>
        </div>
      </div>
    </div>
  );
}
