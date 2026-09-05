import { describe, it, expect } from 'vitest';
import {
  hashPassword, verifyPassword, signValue, verifySigned, ipScopeId,
  normalizeEmail, validatePassword, hashToken,
  sessionCookieHeader, guestCookieHeader, clearSessionCookieHeader,
} from './auth';

describe('password hashing (scrypt)', () => {
  it('hashes and verifies a password', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('correct horse');
    await expect(verifyPassword('correct horse battery staple', h)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const h = await hashPassword('hunterhunter');
    await expect(verifyPassword('hunterhuntre', h)).resolves.toBe(false);
  });

  it('produces a different hash per user (random salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    await expect(verifyPassword('x', 'garbage')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$1$1$1$$')).resolves.toBe(false);
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    // Absurd cost parameters must not be honoured (DoS guard).
    await expect(verifyPassword('x', 'scrypt$999999999$8$1$AAAA$BBBB')).resolves.toBe(false);
  });

  it('never stores the plaintext anywhere in the hash', async () => {
    const h = await hashPassword('s3cret-plaintext');
    expect(h.includes('s3cret')).toBe(false);
  });
});

describe('signed values (guest cookie)', () => {
  it('round-trips a signed id', () => {
    const v = signValue('g_abc123');
    expect(verifySigned(v)).toBe('g_abc123');
  });
  it('rejects tampered payloads', () => {
    const v = signValue('g_abc123');
    expect(verifySigned(v.slice(0, -2) + 'zz')).toBeNull();
  });
  it('rejects unsigned values', () => {
    expect(verifySigned('g_abc123')).toBeNull();
    expect(verifySigned('a.b')).toBeNull();
    expect(verifySigned(undefined)).toBeNull();
  });
});

describe('ip scope hashing', () => {
  it('is stable for the same IP', () => {
    expect(ipScopeId('203.0.113.7')).toBe(ipScopeId('203.0.113.7'));
  });
  it('differs between IPs', () => {
    expect(ipScopeId('203.0.113.7')).not.toBe(ipScopeId('203.0.113.8'));
  });
  it('does not contain the raw IP (hashed with pepper)', () => {
    const id = ipScopeId('203.0.113.7');
    expect(id).not.toContain('203.0.113.7');
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });
  it('collapses IPv6 rotating suffixes to the /64', () => {
    const a = ipScopeId('2001:db8:1:2:1111:2222:3333:4444');
    const b = ipScopeId('2001:db8:1:2:9999:8888:7777:6666');
    expect(a).toBe(b);
  });
  it('distinguishes different IPv6 /64s', () => {
    expect(ipScopeId('2001:db8:1:2::1')).not.toBe(ipScopeId('2001:db8:1:3::1'));
  });
});

describe('input validation', () => {
  it('normalizes emails', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });
  it('rejects invalid emails', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail('a@b.c.d')).toBe('a@b.c.d');
  });
  it('enforces password length 8..200', () => {
    expect(validatePassword('short')).toBeNull();
    expect(validatePassword('12345678')).toBe('12345678');
    expect(validatePassword('x'.repeat(201))).toBeNull();
    expect(validatePassword(42 as unknown as string)).toBeNull();
  });
});

describe('token hashing', () => {
  it('hashes deterministically and does not leak the token', () => {
    const t = 'super-secret-session-token';
    const h = hashToken(t);
    expect(h).toBe(hashToken(t));
    expect(h).not.toContain('super-secret');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('cookie attributes (CHIPS-aware)', () => {
  it('uses SameSite=None; Secure; Partitioned over https so embedded previews keep the session', () => {
    const c = sessionCookieHeader('tok', true);
    expect(c).toContain('SameSite=None');
    expect(c).toContain('Secure');
    expect(c).toContain('Partitioned');
    expect(c).toContain('HttpOnly');
    expect(guestCookieHeader('g_x', true)).toContain('Partitioned');
    expect(clearSessionCookieHeader(true)).toContain('SameSite=None');
  });
  it('uses friendly SameSite=Lax over plain http (local dev)', () => {
    const c = sessionCookieHeader('tok', false);
    expect(c).toContain('SameSite=Lax');
    expect(c).not.toContain('Secure');
    expect(c).not.toContain('Partitioned');
    expect(guestCookieHeader('g_x', false)).not.toContain('Partitioned');
  });
});
