import { describe, it, expect } from 'vitest';
import {
  parseCookies, serializeCookie, sameOrigin, clientIp, rateLimit, randomToken, safeEqual,
  requestIsSecure,
} from './http';

const BASE = 'http://localhost:3000';

describe('cookie parsing/serialization', () => {
  it('parses cookie headers', () => {
    const c = parseCookies(new Request(BASE, { headers: { Cookie: 'a=1; wf_session=abc%2Fdef; b=2' } }));
    expect(c.a).toBe('1');
    expect(c.wf_session).toBe('abc/def');
    expect(c.b).toBe('2');
  });
  it('serializes with security attributes', () => {
    const c = serializeCookie('wf_session', 'tok', { maxAge: 60, sameSite: 'Lax', secure: true });
    expect(c).toContain('wf_session=tok');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Secure');
    expect(c).toContain('Max-Age=60');
    expect(c).toContain('Path=/');
  });
  it('adds Partitioned for CHIPS (embedded/iframe storage)', () => {
    const c = serializeCookie('wf_session', 'tok', { maxAge: 60, sameSite: 'None', secure: true, partitioned: true });
    expect(c).toContain('SameSite=None');
    expect(c).toContain('Secure');
    expect(c).toContain('Partitioned');
  });
});

describe('requestIsSecure', () => {
  it('lets the browser Origin/Referer scheme override a contradictory x-forwarded-proto', () => {
    // next-server itself stamps x-forwarded-proto=http on direct connections;
    // the browser's own Origin (https page behind a TLS proxy) must win.
    expect(requestIsSecure(new Request('http://127.0.0.1:3000/x', {
      method: 'POST', headers: { Origin: 'https://3000-sandbox.e2b.app', 'x-forwarded-proto': 'http' },
    }))).toBe(true);
    expect(requestIsSecure(new Request('http://127.0.0.1:3000/x', {
      method: 'POST', headers: { Origin: 'http://localhost:3000', 'x-forwarded-proto': 'https' },
    }))).toBe(false);
  });
  it('falls back to x-forwarded-proto when no Origin/Referer is present', () => {
    expect(requestIsSecure(new Request('http://127.0.0.1:3000/x', { headers: { 'x-forwarded-proto': 'https' } }))).toBe(true);
    expect(requestIsSecure(new Request('http://127.0.0.1:3000/x', { headers: { 'x-forwarded-proto': 'http' } }))).toBe(false);
  });
  it('infers https from Referer on GETs', () => {
    expect(requestIsSecure(new Request('http://127.0.0.1:3000/x', {
      headers: { Referer: 'https://3000-sandbox.e2b.app/account' },
    }))).toBe(true);
  });
  it('defaults to the request URL scheme', () => {
    expect(requestIsSecure(new Request('http://localhost:3000/x'))).toBe(false);
  });
});

describe('sameOrigin (CSRF guard)', () => {
  it('accepts matching origin and host', () => {
    expect(sameOrigin(new Request(`${BASE}/api/x`, { method: 'POST', headers: { Origin: BASE } }))).toBe(true);
  });
  it('accepts proxy host headers', () => {
    expect(sameOrigin(new Request('http://127.0.0.1:3000/api/x', {
      method: 'POST',
      headers: { Origin: 'https://wf-arb.onrender.com', 'x-forwarded-host': 'wf-arb.onrender.com' },
    }))).toBe(true);
  });
  it('rejects foreign origins', () => {
    expect(sameOrigin(new Request(`${BASE}/api/x`, {
      method: 'POST', headers: { Origin: 'https://evil.example' },
    }))).toBe(false);
  });
  it('rejects missing origin (non-browser clients)', () => {
    expect(sameOrigin(new Request(`${BASE}/api/x`, { method: 'POST' }))).toBe(false);
  });
  it('rejects malformed origin values', () => {
    expect(sameOrigin(new Request(BASE, { headers: { Origin: 'not a url' } }))).toBe(false);
  });
  it('accepts an ALLOWED_HOSTS entry (proxied preview domain)', () => {
    const prev = process.env.ALLOWED_HOSTS;
    process.env.ALLOWED_HOSTS = '3000-sandbox.e2b.app';
    try {
      expect(sameOrigin(new Request('http://127.0.0.1:3000/api/x', {
        method: 'POST',
        headers: { Origin: 'https://3000-sandbox.e2b.app' },
      }))).toBe(true);
      // Still rejects everything else.
      expect(sameOrigin(new Request('http://127.0.0.1:3000/api/x', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
      }))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_HOSTS;
      else process.env.ALLOWED_HOSTS = prev;
    }
  });
  it('accepts a wildcard ALLOWED_HOSTS entry', () => {
    const prev = process.env.ALLOWED_HOSTS;
    process.env.ALLOWED_HOSTS = '*.e2b.app';
    try {
      expect(sameOrigin(new Request('http://10.0.0.5:3000/api/x', {
        method: 'POST',
        headers: { Origin: 'https://3000-any.e2b.app' },
      }))).toBe(true);
      expect(sameOrigin(new Request('http://10.0.0.5:3000/api/x', {
        method: 'POST',
        headers: { Origin: 'https://e2b.app.evil.example' },
      }))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_HOSTS;
      else process.env.ALLOWED_HOSTS = prev;
    }
  });
  it('accepts the APP_URL host', () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = 'https://wf-arb.onrender.com';
    try {
      expect(sameOrigin(new Request('http://127.0.0.1:3000/api/x', {
        method: 'POST',
        headers: { Origin: 'https://wf-arb.onrender.com' },
      }))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prev;
    }
  });
});

describe('clientIp', () => {
  it('takes the first x-forwarded-for entry', () => {
    expect(clientIp(new Request(BASE, { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }))).toBe('203.0.113.9');
  });
  it('falls back to x-real-ip then unknown', () => {
    expect(clientIp(new Request(BASE, { headers: { 'x-real-ip': '198.51.100.2' } }))).toBe('198.51.100.2');
    expect(clientIp(new Request(BASE))).toBe('unknown');
  });
});

describe('rateLimit', () => {
  it('allows up to the limit then blocks with retry-after', () => {
    const key = `rl-test-${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(rateLimit(key, 3, 1000).allowed).toBe(true);
    const blocked = rateLimit(key, 3, 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });
  it('keys are isolated', () => {
    const a = `k1-${Math.random()}`;
    const b = `k2-${Math.random()}`;
    rateLimit(a, 1, 1000);
    expect(rateLimit(a, 1, 1000).allowed).toBe(false);
    expect(rateLimit(b, 1, 1000).allowed).toBe(true);
  });
});

describe('tokens', () => {
  it('randomToken is url-safe and unique', () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(42);
  });
  it('safeEqual compares without short-circuit errors', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('feature gating config', () => {
  it('defaults capital calculator to PRO, existing features free', async () => {
    const { featureTier, featureEnabled } = await import('./features');
    expect(featureTier('capital_calculator')).toBe('pro');
    expect(featureTier('scanner_dashboard')).toBe('free');
    expect(featureTier('watchlist')).toBe('free');
    expect(featureEnabled('capital_calculator', false)).toBe(false);
    expect(featureEnabled('capital_calculator', true)).toBe(true);
    expect(featureEnabled('scanner_dashboard', false)).toBe(true);
  });
  it('supports env overrides', async () => {
    process.env.FEATURES_CAPITAL_CALCULATOR = 'free';
    const { featureEnabled } = await import('./features');
    expect(featureEnabled('capital_calculator', false)).toBe(true);
    delete process.env.FEATURES_CAPITAL_CALCULATOR;
  });
});
