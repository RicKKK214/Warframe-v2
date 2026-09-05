import { headers } from 'next/headers';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSessionUser, isAdminUser } from '@/lib/auth';
import { subscriptionIsPro } from '@/lib/billing';
import { quotaDayKey, FREE_SEARCH_LIMIT } from '@/lib/quota';
import { ShieldCheck, Crown, Mail } from 'lucide-react';

export const dynamic = 'force-dynamic';

/**
 * /admin — operator dashboard (server-rendered, admin-only).
 *
 * Admin = the email is listed in ADMIN_EMAILS, or the FIRST registered user
 * (the founder — on a fresh deployment that is the owner). There is no
 * client-side admin flag anywhere: access is derived from the signed-in
 * session on every render.
 *
 * Shows every account: email, plan, verification, today's search usage and
 * last activity. Accounts intentionally store NO name/profile data — email is
 * the identity (the "name" column is the email handle).
 */
export default async function AdminPage() {
  const h = headers();
  const req = new Request('http://localhost/admin', {
    headers: {
      cookie: h.get('cookie') ?? '',
      'x-forwarded-for': h.get('x-forwarded-for') ?? '',
      'x-forwarded-proto': h.get('x-forwarded-proto') ?? 'https',
    },
  });

  const user = await getSessionUser(req).catch(() => null);
  const isAdmin = await isAdminUser(user);

  if (!user || !isAdmin) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-loss/40 bg-loss/10 text-loss">
          <ShieldCheck size={22} />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-slate-50">Admin only</h1>
        <p className="mt-2 text-sm text-slate-400">
          {user
            ? 'This account does not have admin access. Admin is the first registered account (or an email listed in ADMIN_EMAILS).'
            : 'Log in with the admin account to view this page.'}
        </p>
        <Link href="/login" className="btn-accent mt-5 inline-flex">Go to login</Link>
      </div>
    );
  }

  const day = quotaDayKey();
  const [users, quotaRows] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        subscription: true,
        sessions: { orderBy: { lastSeenAt: 'desc' }, take: 1 },
      },
    }),
    prisma.searchQuota.findMany({ where: { day } }),
  ]);

  const usageByUser = new Map<string, number>();
  let guestSearches = 0;
  for (const row of quotaRows) {
    if (row.scopeType === 'user') usageByUser.set(row.scopeId, row.count);
    if (row.scopeType === 'guest') guestSearches += row.count;
  }

  const proCount = users.filter((u) => subscriptionIsPro(u.subscription)).length;
  const totalSearches = [...usageByUser.values()].reduce((a, b) => a + b, 0) + guestSearches;

  return (
    <div className="mx-auto max-w-4xl space-y-6 py-8">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/15 text-accent2">
          <ShieldCheck size={20} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-50">Admin — accounts</h1>
          <p className="text-xs text-slate-500">
            Every registered account. Emails only — no names or profiles are collected.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Accounts', value: users.length },
          { label: 'PRO subscribers', value: proCount },
          { label: 'Free searches today', value: totalSearches },
          { label: 'Guest searches today', value: guestSearches },
        ].map((s) => (
          <div key={s.label} className="card p-4">
            <div className="text-2xl font-semibold text-slate-50">{s.value}</div>
            <div className="mt-1 text-[11px] uppercase tracking-wider text-slate-500">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/5 text-[11px] uppercase tracking-wider text-slate-500">
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Name (email handle)</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Searches today</th>
              <th className="px-4 py-3">Last active</th>
              <th className="px-4 py-3">Joined</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => {
              const isPro = subscriptionIsPro(u.subscription);
              const handle = u.email.split('@')[0];
              const used = usageByUser.get(u.id) ?? 0;
              const last = u.sessions[0]?.lastSeenAt ?? u.createdAt;
              return (
                <tr key={u.id} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3 text-slate-500">{i + 1}</td>
                  <td className="px-4 py-3 text-slate-200">{handle}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-slate-300">
                      <Mail size={12} className="text-slate-500" />
                      {u.email}
                    </span>
                    {!u.emailVerified ? (
                      <span className="ml-2 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-400">unverified</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {isPro ? (
                      <span className="inline-flex items-center gap-1 rounded bg-accent/20 px-2 py-0.5 text-[11px] font-semibold text-accent2">
                        <Crown size={11} /> PRO
                      </span>
                    ) : (
                      <span className="rounded bg-slate-700/60 px-2 py-0.5 text-[11px] text-slate-300">FREE</span>
                    )}
                    {u.subscription?.cancelAtPeriodEnd && isPro ? (
                      <span className="ml-1 text-[10px] text-slate-500">(ends at period)</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {isPro ? <span className="text-accent2">unlimited</span> : `${used}/${FREE_SEARCH_LIMIT}`}
                  </td>
                  <td className="px-4 py-3 text-slate-400">
                    {new Date(last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}{' '}
                    {new Date(last).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(u.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                </tr>
              );
            })}
            {users.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-slate-500">No accounts yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Admin access: first registered account, or any email in the <code className="text-slate-400">ADMIN_EMAILS</code>{' '}
 environment variable. Quota resets daily at midnight UTC.
      </p>
    </div>
  );
}
