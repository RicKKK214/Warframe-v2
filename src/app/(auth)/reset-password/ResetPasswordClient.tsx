'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthShell, Field, FormError, FormOk, AuthFooterLink } from '../shared';

export default function ResetPasswordClient() {
  const params = useSearchParams();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const token = params.get('token') ?? '';
    if (!token) {
      setError('This page needs a valid reset link (check your email).');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error ?? 'Reset failed.');
        return;
      }
      setOk('Password updated. All previous sessions were logged out.');
      setTimeout(() => router.push('/login'), 1800);
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Choose a new password"
      footer={<AuthFooterLink href="/login">Back to login</AuthFooterLink>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password (8+ characters)">
          <input className="input" type="password" required minLength={8} autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        <Field label="Confirm new password">
          <input className="input" type="password" required minLength={8} autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
        </Field>
        <FormError message={error} />
        <FormOk message={ok} />
        <button className="btn-accent w-full justify-center" disabled={busy || !!ok}>
          {busy ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </AuthShell>
  );
}
