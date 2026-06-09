import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHORT_LINK_TTL_SECONDS = 4 * 60 * 60;
const MAX_URL_LENGTH = 4_000;
const CODE_PATTERN = /^[a-zA-Z0-9_-]{8,32}$/;

type ShortLinkEntry = {
  url: string;
  createdAt: string;
  expiresAt: string;
};

const shortLinks = new Map<string, ShortLinkEntry>();

function jsonResponse(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

function createCode() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function getCode(params: { code?: string[] }) {
  return params.code?.[0] ?? "";
}

function isExpired(entry: ShortLinkEntry) {
  return new Date(entry.expiresAt).getTime() <= Date.now();
}

function normalizeUrl(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("URL is required.");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("URL is required.");
  }

  if (trimmed.length > MAX_URL_LENGTH) {
    throw new Error("URL is too long.");
  }

  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }

  return url.toString();
}

type ShortLinkRouteContext = {
  params: Promise<{ code?: string[] }>;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { url?: unknown };
    const url = normalizeUrl(body.url);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SHORT_LINK_TTL_SECONDS * 1000).toISOString();
    let code = createCode();

    while (shortLinks.has(code)) {
      code = createCode();
    }

    shortLinks.set(code, {
      url,
      createdAt: now.toISOString(),
      expiresAt,
    });

    const shortUrl = new URL(`/go/${code}`, request.url);

    return jsonResponse(
      {
        code,
        shortUrl: shortUrl.toString(),
        expiresAt,
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Unable to create short link.",
      },
      { status: 400 },
    );
  }
}

export async function GET(_request: Request, context: ShortLinkRouteContext) {
  const params = await context.params;
  const code = getCode(params);

  if (!CODE_PATTERN.test(code)) {
    return jsonResponse({ error: "Short link not found." }, { status: 404 });
  }

  const entry = shortLinks.get(code);
  if (!entry) {
    return jsonResponse({ error: "Short link not found." }, { status: 404 });
  }

  if (isExpired(entry)) {
    shortLinks.delete(code);
    return jsonResponse({ error: "Short link expired." }, { status: 410 });
  }

  redirect(entry.url);
}
