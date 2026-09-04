import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'Warframe Prime Arbitrage Scanner',
  description:
    'Independent scanner for Prime set vs individual part arbitrage using public Warframe.market data.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen text-slate-200 antialiased">
        <Nav />
        <main className="mx-auto max-w-[1600px] px-5 py-6">{children}</main>
        <footer className="mx-auto max-w-[1600px] px-5 pb-10 pt-4 text-[11px] leading-relaxed text-slate-600">
          <p>
            Market data courtesy of <a className="text-accent2 hover:underline" href="https://warframe.market"
              target="_blank" rel="noreferrer">Warframe.market</a> public API v2. This is an independent,
            unofficial tool and is not affiliated with Warframe.market or Digital Extremes.
            Warframe is a registered trademark of Digital Extremes Ltd.
          </p>
          <p className="mt-1">
            Estimated profit based on current Warframe.market orders. Actual trade results may differ.
          </p>
        </footer>
      </body>
    </html>
  );
}
