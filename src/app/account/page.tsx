import { Suspense } from 'react';
import AccountClient from './AccountClient';

export const dynamic = 'force-dynamic';

export default function AccountPage() {
  return (
    <Suspense fallback={null}>
      <AccountClient />
    </Suspense>
  );
}
