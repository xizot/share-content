import { isShareSessionError, updateSharedSession } from '@/lib/share-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type UpsertSessionRequest = {
  sessionId?: unknown;
  content?: unknown;
};

function jsonResponse(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...init?.headers,
    },
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as UpsertSessionRequest;

    if (typeof body.sessionId !== 'string' || typeof body.content !== 'string') {
      return jsonResponse(
        { error: 'Request body must include sessionId and content strings.' },
        { status: 400 },
      );
    }

    const session = await updateSharedSession(body.sessionId, {
      text: body.content,
      images: [],
    });
    const url = new URL(`/s/${session.id}`, request.url);

    return jsonResponse({
      session,
      sessionId: session.id,
      url: url.toString(),
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    if (isShareSessionError(error)) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }

    return jsonResponse({ error: 'Unable to upsert session.' }, { status: 500 });
  }
}
