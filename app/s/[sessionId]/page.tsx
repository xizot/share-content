import { ShareSessionPage } from '@/features/share-session/share-session-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  return <ShareSessionPage sessionId={sessionId} />;
}
