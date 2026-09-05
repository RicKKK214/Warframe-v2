'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell, Field, FormError, AuthFooterLink } from '../shared';
import { useAuth } from '@/components/AuthProvider';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error ?? 'Login failed.');
        return;
      }
      // Verify the session cookie actually stuck (embedded previews can block
      // it — tell the user exactly what to do instead of a silent logout).
      const meRes = await fetch('/api/auth/me', { cache: 'no-store' });
      const meJ = await meRes.json().catch(() => null);
      if (meJ && !meJ.authenticated) {
        setError(
          'Your browser blocked the login cookie in this embedded preview. Tap "Allow cookies for the preview" at the bottom of the page (or "Open in a new tab") and log in again.',
        );
        return;
      }
      await refresh();
      router.push('/account');
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Log in"
      subtitle="Access your account, subscription and PRO features."
      footer={<>No account yet? <AuthFooterLink href="/signup">Sign up</AuthFooterLink> · <AuthFooterLink href="/forgot-password">Forgot password?</AuthFooterLink></>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <input className="input" type="email" required autoComplete="email"
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </Field>
        <Field label="Password">
          <input className="input" type="password" required autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        <FormError message={error} />
        <button className="btn-accent w-full justify-center" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </AuthShell>
  );
}
