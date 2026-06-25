import {
  ShareSessionError,
  isShareSessionError,
  updateSharedSession,
} from '@/lib/share-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type UpsertSessionRequest = {
  id?: unknown;
  sessionId?: unknown;
  text?: unknown;
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
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : body.id;
    const content = typeof body.content === 'string' ? body.content : body.text;

    if (typeof sessionId !== 'string' || typeof content !== 'string') {
      return jsonResponse(
        { error: 'Request body must include sessionId and content strings.' },
        { status: 400 },
      );
    }

    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return jsonResponse({ error: 'Session ID is required.' }, { status: 400 });
    }

    let session;
    try {
      session = await updateSharedSession(normalizedSessionId, {
        text: content,
        images: [],
      });
    } catch (error) {
      if (!(error instanceof ShareSessionError) || error.status !== 410) {
        throw error;
      }

      session = await updateSharedSession(normalizedSessionId, {
        text: content,
        images: [],
      });
    }

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
