import { SetDetail } from '@/components/SetDetail';

export const dynamic = 'force-dynamic';

export default function SetPage({ params }: { params: { slug: string } }) {
  return <SetDetail slug={params.slug} />;
}
