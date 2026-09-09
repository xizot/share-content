import {
  createSharedSession,
  getOrCreateSharedSession,
  isShareSessionError,
} from "@/lib/share-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const body = raw ? JSON.parse(raw) : {};
    if (
      !body ||
      (body.sessionId !== undefined && typeof body.sessionId !== "string")
    ) {
      return jsonResponse({ error: "Invalid session ID." }, { status: 400 });
    }
    const session =
      body.sessionId === undefined
        ? await createSharedSession()
        : await getOrCreateSharedSession(body.sessionId);
    const url = new URL(`/s/${session.id}`, request.url);

    return jsonResponse(
      {
        sessionId: session.id,
        url: url.toString(),
        expiresAt: session.expiresAt,
      },
      { status: 201 },
    );
  } catch (error) {
    if (isShareSessionError(error)) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }

    return jsonResponse(
      { error: "Unable to create session." },
      { status: 500 },
    );
  }
}
