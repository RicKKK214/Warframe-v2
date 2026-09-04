'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthShell, FormError, FormOk, AuthFooterLink } from '../shared';

export default function VerifyEmailClient() {
  const params = useSearchParams();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token') ?? '';
    if (!token) {
      setState('error');
      setMessage('Verification link is missing its token.');
      return;
    }
    void (async () => {
      try {
        const r = await fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (r.ok && j.ok) {
          setState('ok');
        } else {
          setState('error');
          setMessage(j.error ?? 'Verification failed.');
        }
      } catch {
        setState('error');
        setMessage('Network error — try the link again.');
      }
    })();
  }, [params]);

  return (
    <AuthShell
      title="Email verification"
      footer={<AuthFooterLink href="/account">Back to account</AuthFooterLink>}
    >
      <div className="space-y-3 text-center">
        {state === 'working' ? <p className="text-sm text-slate-400">Verifying…</p> : null}
        {state === 'ok' ? <FormOk message="Email verified — thanks!" /> : null}
        {state === 'error' ? <FormError message={message} /> : null}
      </div>
    </AuthShell>
  );
}
