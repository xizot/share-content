"use client";

import { Check, Copy, Link2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/design-system/components/ui/button";
import { Input } from "@/design-system/components/ui/input";

type CreateShortLinkResponse = {
  shortUrl: string;
  expiresAt: string;
};

type ErrorResponse = {
  error: string;
};

async function createShortLink(url: string) {
  const response = await fetch("/go", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });
  const payload = (await response.json()) as CreateShortLinkResponse | ErrorResponse;

  if (!response.ok) {
    throw new Error("error" in payload ? payload.error : "Unable to create short link.");
  }

  if (!("shortUrl" in payload)) {
    throw new Error("Unable to create short link.");
  }

  return payload;
}

export default function ShortenPage() {
  const [url, setUrl] = useState("");
  const [shortUrl, setShortUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    setMessage("");
    setCopied(false);

    try {
      const result = await createShortLink(url);
      setShortUrl(result.shortUrl);
      setExpiresAt(result.expiresAt);
      setMessage("");
    } catch (error) {
      setShortUrl("");
      setExpiresAt("");
      setMessage(error instanceof Error ? error.message : "Unable to create short link.");
    } finally {
      setLoading(false);
    }
  };

  const copyShortUrl = async () => {
    await navigator.clipboard.writeText(shortUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <section className="w-full max-w-lg rounded-md border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <Link2 className="size-5" />
          <h1 className="text-lg font-semibold">Short link</h1>
        </div>

        <div className="mt-5 flex flex-col gap-3">
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Paste link..."
            type="url"
          />
          <Button type="button" loading={loading} onClick={handleCreate}>
            Create link
          </Button>
        </div>

        {message ? <p className="mt-3 text-sm text-red-600">{message}</p> : null}

        {shortUrl ? (
          <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="break-all text-sm">{shortUrl}</p>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Expires at {new Date(expiresAt).toLocaleString()}
            </p>
            <Button type="button" variant="outline" className="mt-3" onClick={copyShortUrl}>
              {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
