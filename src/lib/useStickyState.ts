'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * State that persists to localStorage, so a user's filter choices survive a reload,
 * navigation, or closing the tab entirely — they only change when the user changes them.
 *
 * Design notes:
 *  - Initial render always uses `fallback` so the server-rendered and first client render
 *    match; the stored value is applied in an effect. Reading localStorage during render
 *    would cause a hydration mismatch.
 *  - Stored values are MERGED over the defaults rather than replacing them, so adding a new
 *    filter later doesn't leave old visitors with an object missing that key.
 *  - Any storage failure (private mode, quota, disabled cookies) degrades to plain state
 *    instead of breaking the page.
 */
export function useStickyState<T extends object>(
  key: string,
  fallback: T,
): [T, (updater: T | ((prev: T) => T)) => void, { ready: boolean; reset: () => void }] {
  const [value, setValue] = useState<T>(fallback);
  const [ready, setReady] = useState(false);
  const fallbackRef = useRef(fallback);

  // Load once on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<keyof T, unknown>>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          // Merge so unknown/removed keys are dropped and new defaults are picked up.
          const merged = { ...fallbackRef.current };
          for (const k of Object.keys(fallbackRef.current) as Array<keyof T>) {
            const stored = parsed[k];
            // Only accept a stored value if it matches the default's type, so a hand-edited
            // or outdated entry can't put the UI into an impossible state.
            if (stored !== undefined && stored !== null &&
                typeof stored === typeof fallbackRef.current[k]) {
              merged[k] = stored as T[keyof T];
            }
          }
          setValue(merged);
        }
      }
    } catch {
      /* storage unavailable — carry on with defaults */
    } finally {
      setReady(true);
    }
  }, [key]);

  const update = useCallback(
    (updater: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof updater === 'function' ? (updater as (p: T) => T)(prev) : updater;
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore write failures */
        }
        return next;
      });
    },
    [key],
  );

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    setValue(fallbackRef.current);
  }, [key]);

  return [value, update, { ready, reset }];
}
