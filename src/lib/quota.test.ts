import { describe, it, expect } from 'vitest';
import { quotaDayKey } from './quota';

describe('quotaDayKey (daily reset boundary)', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(quotaDayKey(new Date('2026-09-04T12:00:00Z'), 'UTC')).toBe('2026-09-04');
  });

  it('splits days at the UTC midnight boundary', () => {
    expect(quotaDayKey(new Date('2026-09-04T23:59:59Z'), 'UTC')).toBe('2026-09-04');
    expect(quotaDayKey(new Date('2026-09-05T00:00:01Z'), 'UTC')).toBe('2026-09-05');
  });

  it('honours a configured timezone', () => {
    // 00:30 UTC on Sep 4 is still Sep 3 in New York (UTC-4).
    expect(quotaDayKey(new Date('2026-09-04T00:30:00Z'), 'America/New_York')).toBe('2026-09-03');
    expect(quotaDayKey(new Date('2026-09-04T04:30:00Z'), 'America/New_York')).toBe('2026-09-04');
  });

  it('falls back to UTC for an invalid timezone', () => {
    expect(quotaDayKey(new Date('2026-09-04T12:00:00Z'), 'Not/AZone')).toBe('2026-09-04');
  });
});
