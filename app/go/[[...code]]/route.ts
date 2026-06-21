import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHORT_LINK_TTL_SECONDS = 4 * 60 * 60;
const MAX_URL_LENGTH = 4_000;
const CODE_PATTERN = /^[a-zA-Z0-9_-]{8,32}$/;
const PREVIEW_USER_AGENT_PATTERN =
  /bot|crawler|spider|preview|facebookexternalhit|facebot|twitterbot|slackbot|discordbot|telegrambot|whatsapp|skypeuripreview|linkedinbot|embedly|pinterest|redditbot|applebot|zalo|viber|line/i;

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

function noPreviewResponse(status = 200, includeBody = true) {
  return new Response(
    includeBody
      ? `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow,noarchive,nosnippet" />
    <meta property="og:title" content="Short link" />
    <meta property="og:description" content="Open this link in your browser." />
    <meta name="twitter:card" content="summary" />
    <title>Short link</title>
  </head>
  <body>
    <p>Open this link in your browser.</p>
  </body>
</html>`
      : null,
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      },
    },
  );
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

function isLinkPreviewRequest(request: Request) {
  const userAgent = request.headers.get("user-agent") ?? "";

  return request.method === "HEAD" || PREVIEW_USER_AGENT_PATTERN.test(userAgent);
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

async function resolveShortLink(request: Request, context: ShortLinkRouteContext) {
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

  if (isLinkPreviewRequest(request)) {
    return noPreviewResponse(200, request.method !== "HEAD");
  }

  redirect(entry.url);
}

export async function GET(request: Request, context: ShortLinkRouteContext) {
  return resolveShortLink(request, context);
}

export async function HEAD(request: Request, context: ShortLinkRouteContext) {
  return resolveShortLink(request, context);
}
