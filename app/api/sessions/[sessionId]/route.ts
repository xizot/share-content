import {
  deleteSharedSession,
  getOrCreateSharedSession,
  isShareSessionError,
  updateSharedSession,
  type SharedImage,
} from '@/lib/share-session';

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

function isImageArray(value: unknown): value is SharedImage[] {
  return Array.isArray(value);
}

type SessionRouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function GET(_request: Request, context: SessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const session = await getOrCreateSharedSession(sessionId);

    return jsonResponse({ session });
  } catch (error) {
    if (isShareSessionError(error)) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }

    return jsonResponse({ error: 'Unable to load session.' }, { status: 500 });
  }
}

export async function PUT(request: Request, context: SessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const body = (await request.json()) as { text?: unknown; images?: unknown };

    if (typeof body.text !== 'string' || !isImageArray(body.images)) {
      return jsonResponse({ error: 'Invalid request body.' }, { status: 400 });
    }

    const session = await updateSharedSession(sessionId, {
      text: body.text,
      images: body.images,
    });

    return jsonResponse({ session });
  } catch (error) {
    if (isShareSessionError(error)) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }

    return jsonResponse({ error: 'Unable to save session.' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: SessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    await deleteSharedSession(sessionId);

    return jsonResponse({ ok: true });
  } catch (error) {
    if (isShareSessionError(error)) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }

    return jsonResponse({ error: 'Unable to delete session.' }, { status: 500 });
  }
}
