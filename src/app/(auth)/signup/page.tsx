'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell, Field, FormError, AuthFooterLink } from '../shared';
import { useAuth } from '@/components/AuthProvider';

export default function SignupPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error ?? 'Signup failed.');
        return;
      }
      await refresh();
      // New accounts are FREE — never imply signup alone grants unlimited.
      router.push('/account?welcome=1');
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="Free accounts keep the 5 daily set searches. PRO ($6.99/month) unlocks unlimited searches and the Capital Calculator."
      footer={<>Already have an account? <AuthFooterLink href="/login">Log in</AuthFooterLink></>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <input className="input" type="email" required autoComplete="email"
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </Field>
        <Field label="Password (8+ characters)">
          <input className="input" type="password" required minLength={8} autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        <Field label="Confirm password">
          <input className="input" type="password" required minLength={8} autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
        </Field>
        <FormError message={error} />
        <button className="btn-accent w-full justify-center" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
        <p className="text-center text-[11px] text-slate-500">
          Free plan: 5 set searches per day. Upgrade to PRO anytime for unlimited.
        </p>
      </form>
    </AuthShell>
  );
}
