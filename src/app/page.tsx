import { OpportunityTable } from '@/components/OpportunityTable';
import { Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <Card className="border-accent/20 bg-gradient-to-r from-panel to-panel2/40">
        <h1 className="text-xl font-semibold text-slate-50">Prime Set vs Parts Arbitrage</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Live analysis of public Warframe.market order books. Every Prime set is evaluated in both
          directions — buying components to sell a complete set, and splitting a purchased set into parts —
          under both an instant flip (sell into existing buy orders) and a listing flip
          (post your own competitive sell order).
        </p>
      </Card>
      <OpportunityTable />
    </div>
  );
}
