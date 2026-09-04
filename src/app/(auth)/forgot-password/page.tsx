'use client';
import { useState } from 'react';
import { AuthShell, Field, FormError, FormOk, AuthFooterLink } from '../shared';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error ?? 'Request failed.');
        return;
      }
      if (j.sent === false && j.reason === 'email_not_configured') {
        setError('Password reset is unavailable on this deployment (no email provider configured). Contact the site owner.');
      } else {
        setOk('If an account exists for that email, a reset link is on its way. It expires in 1 hour.');
      }
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We'll email you a single-use reset link."
      footer={<AuthFooterLink href="/login">Back to login</AuthFooterLink>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <input className="input" type="email" required autoComplete="email"
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </Field>
        <FormError message={error} />
        <FormOk message={ok} />
        <button className="btn-accent w-full justify-center" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
    </AuthShell>
  );
}
