/**
 * AUTH integration tests — run the REAL route handlers against REAL PostgreSQL.
 * No mocks on the auth/database path: signup → login → logout → sessions →
 * password reset are exercised exactly as production would.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@/lib/db';

const BASE = 'http://localhost:3000';
const H = { 'Content-Type': 'application/json', Origin: BASE };

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, { ...init });
}

function cookieOf(res: Response, name: string): string | null {
  const set = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean) as string[];
  for (const c of set) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

async function truncate() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Session", "AuthToken", "Subscription", "WebhookEvent", "User", "SearchQuota" CASCADE',
  );
}

beforeAll(async () => {
  await truncate();
});

describe('signup', () => {
  it('creates a FREE account (not PRO) and a session', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(req('/api/auth/signup', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'Free@Example.com ', password: 'password123' }),
    }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.user.email).toBe('free@example.com');
    // NEW ACCOUNTS ARE FREE — never automatically PRO.
    const sub = await prisma.subscription.findUnique({ where: { userId: j.user.id } });
    expect(sub?.status ?? 'inactive').not.toBe('active');
    const cookie = cookieOf(res, 'wf_session');
    expect(cookie).toBeTruthy();
    // HttpOnly + SameSite=Lax hardening.
    const raw = res.headers.get('set-cookie') ?? '';
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
  });

  it('rejects weak passwords', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(req('/api/auth/signup', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'x@example.com', password: 'short' }),
    }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid emails', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(req('/api/auth/signup', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'not-an-email', password: 'password123' }),
    }));
    expect(res.status).toBe(400);
  });

  it('rejects duplicate email with 409', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(req('/api/auth/signup', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'free@example.com', password: 'password123' }),
    }));
    expect(res.status).toBe(409);
  });

  it('rejects cross-origin requests (CSRF)', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(req('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'evil@example.com', password: 'password123' }),
    }));
    expect(res.status).toBe(403);
  });

  it('stores only password hashes, never plaintext', async () => {
    const user = await prisma.user.findUnique({ where: { email: 'free@example.com' } });
    expect(user).toBeTruthy();
    expect(user!.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(user!.passwordHash).not.toContain('password123');
  });
});

describe('login', () => {
  it('logs in with valid credentials and issues a session cookie', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req('/api/auth/login', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'FREE@example.com', password: 'password123' }),
    }));
    expect(res.status).toBe(200);
    expect(cookieOf(res, 'wf_session')).toBeTruthy();
  });

  it('rejects an invalid password with 401 and a generic message', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req('/api/auth/login', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'free@example.com', password: 'wrong-password' }),
    }));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error).toBe('Invalid email or password.');
  });

  it('rejects a non-existent user identically (no enumeration)', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req('/api/auth/login', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'ghost@example.com', password: 'whatever-123' }),
    }));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error).toBe('Invalid email or password.');
  });
});

describe('session persistence / me', () => {
  it('me reflects the logged-in FREE user with quota info', async () => {
    const { POST: login } = await import('@/app/api/auth/login/route');
    const { GET } = await import('@/app/api/auth/me/route');
    const loginRes = await login(req('/api/auth/login', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'free@example.com', password: 'password123' }),
    }));
    const cookie = cookieOf(loginRes, 'wf_session')!;

    const me = await GET(req('/api/auth/me', { headers: { Cookie: `wf_session=${cookie}` } }));
    const j = await me.json();
    expect(j.ok).toBe(true);
    expect(j.authenticated).toBe(true);
    expect(j.isPro).toBe(false); // FREE — server-derived
    expect(j.email).toBe('free@example.com');
    expect(j.quota.unlimited).toBe(false);
    expect(j.quota.limit).toBe(5);
  });

  it('me works for anonymous guests and mints a guest cookie', async () => {
    const { GET } = await import('@/app/api/auth/me/route');
    const res = await GET(req('/api/auth/me'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.authenticated).toBe(false);
    expect(j.isPro).toBe(false);
    const guest = cookieOf(res, 'wf_guest');
    expect(guest).toBeTruthy();
    expect(guest).toMatch(/^g_.+\..+$/); // signed id.signature
  });

  it('an invalid session cookie is treated as anonymous', async () => {
    const { GET } = await import('@/app/api/auth/me/route');
    const res = await GET(req('/api/auth/me', { headers: { Cookie: 'wf_session=totally-forged-token' } }));
    const j = await res.json();
    expect(j.authenticated).toBe(false);
    // Subscription status cannot be spoofed from the client.
    expect(j.isPro).toBe(false);
  });
});

describe('logout', () => {
  it('revokes the session server-side; the cookie no longer works', async () => {
    const { POST: login } = await import('@/app/api/auth/login/route');
    const { POST: logout } = await import('@/app/api/auth/logout/route');
    const { GET } = await import('@/app/api/auth/me/route');

    const loginRes = await login(req('/api/auth/login', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'free@example.com', password: 'password123' }),
    }));
    const cookie = cookieOf(loginRes, 'wf_session')!;
    await logout(req('/api/auth/logout', { method: 'POST', headers: { ...H, Cookie: `wf_session=${cookie}` } }));

    const me = await GET(req('/api/auth/me', { headers: { Cookie: `wf_session=${cookie}` } }));
    expect((await me.json()).authenticated).toBe(false);
  });
});

describe('logout everywhere', () => {
  it('revokes ALL sessions for the user', async () => {
    const { POST: login } = await import('@/app/api/auth/login/route');
    const { POST: logoutAll } = await import('@/app/api/auth/logout-all/route');
    const { GET } = await import('@/app/api/auth/me/route');

    const a = await login(req('/api/auth/login', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'free@example.com', password: 'password123' }),
    }));
    const b = await login(req('/api/auth/login', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'free@example.com', password: 'password123' }),
    }));
    const cookieA = cookieOf(a, 'wf_session')!;
    const cookieB = cookieOf(b, 'wf_session')!;

    const res = await logoutAll(req('/api/auth/logout-all', {
      method: 'POST', headers: { ...H, Cookie: `wf_session=${cookieA}` },
    }));
    expect(res.status).toBe(200);

    for (const c of [cookieA, cookieB]) {
      const me = await GET(req('/api/auth/me', { headers: { Cookie: `wf_session=${c}` } }));
      expect((await me.json()).authenticated).toBe(false);
    }
  });

  it('requires authentication', async () => {
    const { POST } = await import('@/app/api/auth/logout-all/route');
    const res = await POST(req('/api/auth/logout-all', { method: 'POST', headers: H }));
    expect(res.status).toBe(401);
  });
});

describe('password reset flow', () => {
  it('issues a single-use token, resets the password, revokes sessions', async () => {
    const { issueAuthToken, consumeAuthToken } = await import('@/lib/auth');
    const { POST: reset } = await import('@/app/api/auth/reset-password/route');
    const { POST: login } = await import('@/app/api/auth/login/route');

    // Simulate the emailed link: the token exists only server-side.
    const user = await prisma.user.findUnique({ where: { email: 'free@example.com' } });
    const token = await issueAuthToken(user!.id, 'password_reset');

    const res = await reset(req('/api/auth/reset-password', {
      method: 'POST', headers: H,
      body: JSON.stringify({ token, password: 'new-password-456' }),
    }));
    expect(res.status).toBe(200);

    // Old password no longer works; new one does.
    const oldLogin = await login(req('/api/auth/login', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'free@example.com', password: 'password123' }),
    }));
    expect(oldLogin.status).toBe(401);
    const newLogin = await login(req('/api/auth/login', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email: 'free@example.com', password: 'new-password-456' }),
    }));
    expect(newLogin.status).toBe(200);

    // Token is single-use.
    expect(await consumeAuthToken(token, 'password_reset')).toBeNull();
  });

  it('rejects an invalid/expired reset token', async () => {
    const { POST } = await import('@/app/api/auth/reset-password/route');
    const res = await POST(req('/api/auth/reset-password', {
      method: 'POST', headers: H,
      body: JSON.stringify({ token: 'f'.repeat(43), password: 'another-pass-789' }),
    }));
    expect(res.status).toBe(400);
  });

  it('forgot-password responds identically for unknown emails (no enumeration)', async () => {
    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const mk = (email: string) => POST(req('/api/auth/forgot-password', {
      method: 'POST', headers: H,
      body: JSON.stringify({ email }),
    }));
    const unknown = await mk('unknown@example.com');
    const known = await mk('free@example.com');
    expect(unknown.status).toBe(200);
    // Without SMTP configured both answers are {sent:false, reason:...}; with
    // SMTP both are {sent:true}. Either way they MUST be identical.
    expect(await unknown.json()).toEqual(await known.json());
  });
});

describe('rate limiting', () => {
  it('locks out repeated failed logins from one IP', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    // The suite already made several attempts; keep hammering until 429.
    let got429 = false;
    for (let i = 0; i < 20 && !got429; i++) {
      const res = await POST(req('/api/auth/login', {
        method: 'POST', headers: { ...H, 'x-forwarded-for': '9.9.9.9' },
        body: JSON.stringify({ email: 'rl@example.com', password: 'wrong-password' }),
      }));
      if (res.status === 429) got429 = true;
    }
    expect(got429).toBe(true);
  });
});
