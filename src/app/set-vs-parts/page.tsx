'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { Card, Spinner, EmptyState } from '@/components/ui';
import { SetDetail } from '@/components/SetDetail';

interface Item { slug: string; name: string; isPrimeSet: boolean; category: string }

export default function SetVsPartsPage() {
  const [q, setQ] = useState('Wisp Prime');
  const [results, setResults] = useState<Item[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    const t = setTimeout(async () => {
      if (!q.trim()) { setResults([]); return; }
      setLoading(true);
      try {
        const r = await fetch(`/api/items/search?q=${encodeURIComponent(q)}`, { signal: c.signal });
        const j = await r.json();
        const items = ((j.data ?? []) as Item[]).filter((i) => i.isPrimeSet);
        setResults(items);
        if (items.length && !slug) setSlug(items[0].slug);
      } catch { /* aborted */ } finally { setLoading(false); }
    }, 300);
    return () => { c.abort(); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="space-y-5">
      <Card>
        <h1 className="text-lg font-semibold text-slate-100">Set vs Parts comparison</h1>
        <p className="mt-1 text-sm text-slate-400">
          Search any Prime set to compare the complete-set market price against the sum of its components.
        </p>
        <div className="relative mt-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input className="input pl-9" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search Wisp Prime" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {loading ? <Spinner label="Searching catalog…" /> : null}
          {results.slice(0, 12).map((i) => (
            <button key={i.slug} onClick={() => setSlug(i.slug)}
              className={`chip ${slug === i.slug ? 'border-accent/60 text-accent2' : ''}`}>
              {i.name}
            </button>
          ))}
          {!loading && q.trim() && !results.length ? (
            <span className="text-xs text-slate-500">No tradable Prime sets match “{q}”.</span>
          ) : null}
        </div>
      </Card>

      {slug ? (
        <>
          <SetDetail slug={slug} />
          <Link className="text-xs text-accent2 hover:underline" href={`/sets/${slug}`}>
            Open dedicated page → /sets/{slug}
          </Link>
        </>
      ) : (
        <EmptyState title="Search a Prime set to begin" hint="For example: Wisp Prime, Mesa Prime, Gram Prime." />
      )}
    </div>
  );
}
