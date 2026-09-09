import { parseCurl } from '@/lib/curl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_COMMAND_LENGTH = 200_000;
const MAX_RESPONSE_LENGTH = 200_000;
const REQUEST_TIMEOUT_MS = 30_000;

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
    const body = (await request.json()) as { curl?: unknown };
    if (typeof body.curl !== 'string' || !body.curl.trim()) {
      return jsonResponse({ error: 'cURL command is required.' }, { status: 400 });
    }
    if (body.curl.length > MAX_COMMAND_LENGTH) {
      return jsonResponse({ error: 'cURL command is too large.' }, { status: 413 });
    }

    const curl = parseCurl(body.curl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(curl.url, {
        method: curl.method,
        headers: curl.headers,
        body: curl.body,
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await response.text();
    const truncated = responseText.length > MAX_RESPONSE_LENGTH;
    return jsonResponse({
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: truncated ? responseText.slice(0, MAX_RESPONSE_LENGTH) : responseText,
      truncated,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Request timed out.'
        : error instanceof Error
          ? error.message
          : 'Unable to send cURL request.';
    return jsonResponse({ error: message }, { status: 400 });
  }
}
