import { getSharedSessionRevision, isShareSessionError } from '@/lib/share-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonResponse(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...init?.headers,
    },
  });
}

type SessionRevisionRouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function GET(_request: Request, context: SessionRevisionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const session = await getSharedSessionRevision(sessionId);

    return jsonResponse({ session });
  } catch (error) {
    if (isShareSessionError(error)) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }

    return jsonResponse({ error: 'Unable to load session revision.' }, { status: 500 });
  }
}
