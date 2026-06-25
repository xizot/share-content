"use client";

import {
  Check,
  Copy,
  Download,
  Eraser,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  RotateCcw,
  Share2,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import NextImage from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/design-system/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/design-system/components/ui/dialog";
import { ThemeToggle } from "@/design-system/components/ui/theme-toggle";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TEXT_LENGTH,
  type SharedImage,
  type SharedSession,
} from "@/lib/share-session-schema";

type ApiSessionResponse = {
  session: SharedSession;
};

type ApiSessionRevisionResponse = {
  session: {
    id: string;
    revision: number;
    updatedAt: string;
    expiresAt: string;
  };
};

type ApiErrorResponse = {
  error: string;
};

type SaveStatus = "idle" | "loading" | "saving" | "saved" | "error" | "expired";

type ShareSessionPageProps = {
  sessionId: string;
};

type RequestLog = {
  baseUrl?: unknown;
  path?: unknown;
  headers?: unknown;
  method?: unknown;
  requestData?: unknown;
  queryParameters?: unknown;
};

const SAVE_DEBOUNCE_MS = 200;
const REVISION_POLL_MS = 5000;
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const OMITTED_CURL_HEADERS = new Set(["content-length"]);

function createImageId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getPayloadFingerprint(text: string, images: SharedImage[]) {
  return JSON.stringify({
    text,
    images: images.map((image) => ({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      base64: image.base64,
      size: image.size,
      createdAt: image.createdAt,
    })),
  });
}

function getDisplayMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return message === "Session not found." ? "" : message;
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T | ApiErrorResponse;

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? payload.error
        : "Request failed.";
    throw new Error(message);
  }

  return payload as T;
}

function readImageFile(file: File): Promise<SharedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Invalid image data."));
        return;
      }

      resolve({
        id: createImageId(),
        name: file.name,
        mimeType: file.type,
        base64: reader.result,
        size: file.size,
        createdAt: new Date().toISOString(),
      });
    };

    reader.onerror = () => reject(new Error("Unable to read image."));
    reader.readAsDataURL(file);
  });
}

function getSafeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "image";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function appendQueryParameters(url: URL, queryParameters: unknown) {
  if (!isRecord(queryParameters)) return;

  for (const [key, value] of Object.entries(queryParameters)) {
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && item !== undefined) {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }
}

function buildRequestUrl(baseUrl: string, path: string, queryParameters: unknown) {
  const url = /^https?:\/\//i.test(path)
    ? new URL(path)
    : new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`);

  appendQueryParameters(url, queryParameters);
  return url.toString();
}

function formatCurlHeaderValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(", ");
  }

  if (isRecord(value)) {
    return JSON.stringify(value);
  }

  return String(value);
}

function parseTextAsCurl(value: string) {
  let payload: RequestLog;

  try {
    payload = JSON.parse(value.trim()) as RequestLog;
  } catch {
    throw new Error("Text is not a valid JSON request log.");
  }

  if (!isRecord(payload)) {
    throw new Error("Text is not a valid JSON request log.");
  }

  const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl : "";
  const path = typeof payload.path === "string" ? payload.path : "";
  const method =
    typeof payload.method === "string" ? payload.method.toUpperCase() : "GET";

  if (!baseUrl && !/^https?:\/\//i.test(path)) {
    throw new Error("Request log needs baseUrl and path.");
  }

  const lines = [
    `curl --location --request ${method} ${shellQuote(
      buildRequestUrl(baseUrl, path, payload.queryParameters),
    )}`,
  ];

  if (isRecord(payload.headers)) {
    for (const [name, headerValue] of Object.entries(payload.headers)) {
      if (
        headerValue === null ||
        headerValue === undefined ||
        OMITTED_CURL_HEADERS.has(name.toLowerCase())
      ) {
        continue;
      }

      lines.push(
        `  --header ${shellQuote(`${name}: ${formatCurlHeaderValue(headerValue)}`)}`,
      );
    }
  }

  if ("requestData" in payload && !BODYLESS_METHODS.has(method)) {
    lines.push(
      `  --data-raw ${shellQuote(JSON.stringify(payload.requestData, null, 2))}`,
    );
  }

  return lines.join(" \\\n");
}

export function ShareSessionPage({ sessionId }: ShareSessionPageProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<SharedImage[]>([]);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [message, setMessage] = useState("Loading session...");
  const [copied, setCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [hasRemoteUpdate, setHasRemoteUpdate] = useState(false);

  const latestFingerprintRef = useRef("");
  const revisionRef = useRef(0);
  const updatedAtRef = useRef("");
  const textRef = useRef("");
  const imagesRef = useRef<SharedImage[]>([]);
  const dirtyRef = useRef(false);
  const remoteUpdateRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applySession = useCallback((session: SharedSession) => {
    setText(session.text);
    setImages(session.images);
    textRef.current = session.text;
    imagesRef.current = session.images;
    revisionRef.current = session.revision;
    updatedAtRef.current = session.updatedAt;
    latestFingerprintRef.current = getPayloadFingerprint(
      session.text,
      session.images,
    );
    dirtyRef.current = false;
    remoteUpdateRef.current = false;
    setHasUnsavedChanges(false);
    setHasRemoteUpdate(false);
  }, []);

  const loadSession = useCallback(
    async (mode: "initial" | "manual" = "initial") => {
      if (mode === "initial") {
        setStatus("loading");
        setMessage("Loading session...");
      } else {
        setMessage("Refreshing...");
      }

      const response = await fetch(`/api/sessions/${sessionId}`, {
        cache: "no-store",
      });
      const payload = await parseApiResponse<ApiSessionResponse>(response);

      if (mode === "manual" && dirtyRef.current) {
        setStatus("idle");
        setMessage("Save current changes before refreshing.");
        return;
      }

      applySession(payload.session);
      setStatus("saved");
      setMessage("Saved");
    },
    [applySession, sessionId],
  );

  const saveSession = useCallback(
    async (nextText: string, nextImages: SharedImage[]) => {
      const fingerprint = getPayloadFingerprint(nextText, nextImages);
      if (fingerprint === latestFingerprintRef.current) {
        dirtyRef.current = false;
        setHasUnsavedChanges(false);
        return;
      }

      setStatus("saving");
      setMessage("Saving...");

      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: nextText,
          images: nextImages,
        }),
      });
      const payload = await parseApiResponse<ApiSessionResponse>(response);
      const currentFingerprint = getPayloadFingerprint(
        textRef.current,
        imagesRef.current,
      );

      if (currentFingerprint === fingerprint) {
        applySession(payload.session);
        setStatus("saved");
        setMessage("Saved");
        return;
      }

      revisionRef.current = payload.session.revision;
      updatedAtRef.current = payload.session.updatedAt;
      setStatus("idle");
      setMessage("");
    },
    [applySession, sessionId],
  );

  const saveCurrentSession = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    await saveSession(textRef.current, imagesRef.current);
  }, [saveSession]);

  const createNewSession = useCallback(async () => {
    setStatus("loading");
    setMessage("Creating session...");

    const response = await fetch("/api/sessions", {
      method: "POST",
    });
    const payload = await parseApiResponse<{ url: string }>(response);
    window.location.assign(payload.url);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      loadSession().catch((error: unknown) => {
        setStatus("error");
        setMessage(getDisplayMessage(error, "Unable to load session."));
      });
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [loadSession]);

  useEffect(() => {
    const fingerprint = getPayloadFingerprint(text, images);
    if (!dirtyRef.current || fingerprint === latestFingerprintRef.current)
      return;

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      saveSession(text, images).catch((error: unknown) => {
        const nextMessage = getDisplayMessage(error, "Unable to save session.");
        setStatus(
          nextMessage.toLowerCase().includes("expired") ? "expired" : "error",
        );
        setMessage(nextMessage);
      });
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [images, saveSession, text]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") {
        return;
      }

      event.preventDefault();
      void saveCurrentSession().catch((error: unknown) => {
        const nextMessage = getDisplayMessage(error, "Unable to save session.");
        setStatus(
          nextMessage.toLowerCase().includes("expired") ? "expired" : "error",
        );
        setMessage(nextMessage);
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveCurrentSession]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && status !== "saving") return;

      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    let inFlight = false;

    const clearPollTimeout = () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const canPoll = () =>
      document.visibilityState === "visible" &&
      status !== "loading" &&
      status !== "expired" &&
      !hasRemoteUpdate;

    const scheduleNextPoll = (delay = REVISION_POLL_MS) => {
      clearPollTimeout();
      if (!cancelled && canPoll()) {
        timeoutId = window.setTimeout(pollRevision, delay);
      }
    };

    const pollRevision = async () => {
      if (cancelled || !canPoll()) return;

      if (inFlight) {
        scheduleNextPoll();
        return;
      }

      inFlight = true;

      try {
        const response = await fetch(`/api/sessions/${sessionId}/revision`, {
          cache: "no-store",
        });
        const payload =
          await parseApiResponse<ApiSessionRevisionResponse>(response);

        const hasNewerRevision = payload.session.revision > revisionRef.current;
        const hasNewerTimestamp =
          Boolean(updatedAtRef.current) &&
          payload.session.updatedAt !== updatedAtRef.current;

        if ((hasNewerRevision || hasNewerTimestamp) && !remoteUpdateRef.current) {
          remoteUpdateRef.current = true;
          setHasRemoteUpdate(true);
        }
      } catch {
        // Keep revision polling quiet; the main load/save flows surface errors.
      } finally {
        inFlight = false;
        scheduleNextPoll();
      }
    };

    scheduleNextPoll();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleNextPoll(0);
        return;
      }

      clearPollTimeout();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearPollTimeout();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [hasRemoteUpdate, sessionId, status]);

  const updateText = (value: string) => {
    if (value.length > MAX_TEXT_LENGTH) {
      setStatus("error");
      setMessage(`Text limit is ${formatBytes(MAX_TEXT_LENGTH)}.`);
      return;
    }

    dirtyRef.current = true;
    setHasUnsavedChanges(true);
    textRef.current = value;
    setText(value);
    setStatus("idle");
    setMessage("");
  };

  const addFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const slotsLeft = MAX_IMAGES - imagesRef.current.length;
    const acceptedFiles = files.slice(0, slotsLeft);

    if (acceptedFiles.length < files.length) {
      setStatus("error");
      setMessage(`Image limit is ${MAX_IMAGES}.`);
    }

    const invalidFile = acceptedFiles.find(
      (file) =>
        !ALLOWED_IMAGE_TYPES.includes(
          file.type as (typeof ALLOWED_IMAGE_TYPES)[number],
        ) || file.size > MAX_IMAGE_BYTES,
    );

    if (invalidFile) {
      setStatus("error");
      setMessage(
        `Use PNG, JPG, WebP, or GIF up to ${formatBytes(MAX_IMAGE_BYTES)}.`,
      );
      return;
    }

    const nextImages = await Promise.all(acceptedFiles.map(readImageFile));
    if (nextImages.length === 0) return;

    dirtyRef.current = true;
    setHasUnsavedChanges(true);
    const updatedImages = [...imagesRef.current, ...nextImages];
    imagesRef.current = updatedImages;
    setImages(updatedImages);
    setStatus("idle");
    setMessage("");
  };

  const removeImage = (imageId: string) => {
    dirtyRef.current = true;
    setHasUnsavedChanges(true);
    const updatedImages = imagesRef.current.filter(
      (image) => image.id !== imageId,
    );
    imagesRef.current = updatedImages;
    setImages(updatedImages);
    setStatus("idle");
    setMessage("");
  };

  const copyText = async () => {
    await navigator.clipboard.writeText(textRef.current);
    setTextCopied(true);
    setMessage("Text copied");
    window.setTimeout(() => setTextCopied(false), 1500);
  };

  const copyAsCurl = async () => {
    try {
      const curl = parseTextAsCurl(textRef.current);
      await navigator.clipboard.writeText(curl);
      setCurlCopied(true);
      setMessage("cURL copied");
      window.setTimeout(() => setCurlCopied(false), 1500);
    } catch (error: unknown) {
      setMessage(
        error instanceof Error ? error.message : "Unable to parse cURL.",
      );
    }
  };

  const clearText = () => {
    if (!textRef.current) return;

    setClearConfirmOpen(true);
  };

  const confirmClearText = () => {
    updateText("");
    setClearConfirmOpen(false);
  };

  const downloadImage = (image: SharedImage) => {
    const link = document.createElement("a");
    link.href = image.base64;
    link.download = getSafeFileName(image.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const copyLink = async () => {
    const shareUrl = `${window.location.origin}/s/${sessionId}`;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const refreshSession = () => {
    loadSession("manual").catch((error: unknown) => {
      const nextMessage = getDisplayMessage(
        error,
        "Unable to refresh session.",
      );
      setStatus(
        nextMessage.toLowerCase().includes("expired") ? "expired" : "error",
      );
      setMessage(nextMessage);
    });
  };

  const statusLabel = (() => {
    if (status === "loading") return "Loading";
    if (status === "saving") return "Saving...";
    if (status === "error") return message || "Unable to save";
    if (status === "expired") return message || "Expired";
    if (hasUnsavedChanges) return "Unsaved";
    if (status === "saved") return message || "Saved";
    return message || "Ready";
  })();

  const statusClassName = (() => {
    if (status === "error" || status === "expired") {
      return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300";
    }

    if (status === "saving" || hasUnsavedChanges) {
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300";
    }

    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300";
  })();

  return (
    <main className="relative h-screen overflow-hidden bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(to_right,rgba(24,24,27,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(24,24,27,0.06)_1px,transparent_1px)] bg-[size:32px_32px] [mask-image:radial-gradient(ellipse_at_center,black_0%,black_52%,transparent_82%)] dark:bg-[linear-gradient(to_right,rgba(244,244,245,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(244,244,245,0.06)_1px,transparent_1px)]"
      />
      <div className="relative mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex shrink-0 flex-col gap-4 border-b border-zinc-200 pb-4 dark:border-zinc-800 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href="/"
                className="text-2xl font-semibold tracking-normal outline-none transition-colors hover:text-zinc-700 focus-visible:ring-3 focus-visible:ring-zinc-400/50 dark:hover:text-zinc-300"
              >
                Share Content
              </Link>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <ThemeToggle />
            <Button
              type="button"
              size={"sm"}
              variant="outline"
              onClick={copyLink}
            >
              {copied ? (
                <Check data-icon="inline-start" />
              ) : (
                <Share2 data-icon="inline-start" />
              )}
              {copied ? "Copied" : "Share link"}
            </Button>
            <Button
              type="button"
              size={"sm"}
              variant="outline"
              onClick={refreshSession}
            >
              <RefreshCw data-icon="inline-start" />
              Refresh
            </Button>
            <Button type="button" size={"sm"} onClick={createNewSession}>
              <Plus data-icon="inline-start" />
              New session
            </Button>
          </div>
        </header>

        <section className="grid min-h-0 flex-1 gap-5 overflow-hidden py-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-h-0 flex-col rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <span className="text-sm font-medium">Text</span>
              <div className="flex items-center gap-1">
                <span
                  className={[
                    "mr-2 rounded-md border px-2 py-1 text-xs font-medium",
                    statusClassName,
                  ].join(" ")}
                >
                  {statusLabel}
                </span>
                <span className="mr-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {text.length.toLocaleString()} /{" "}
                  {MAX_TEXT_LENGTH.toLocaleString()}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Copy as cURL"
                  disabled={!text}
                  onClick={copyAsCurl}
                >
                  {curlCopied ? (
                    <Check data-icon="inline-start" />
                  ) : (
                    <Terminal data-icon="inline-start" />
                  )}
                  cURL
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy full text"
                  disabled={!text}
                  onClick={copyText}
                >
                  {textCopied ? <Check /> : <Copy />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear text"
                  disabled={!text || status === "expired"}
                  onClick={clearText}
                >
                  <Eraser />
                </Button>
              </div>
            </div>
            <textarea
              value={text}
              onChange={(event) => updateText(event.target.value)}
              placeholder="Paste text here..."
              disabled={status === "expired"}
              className="min-h-0 flex-1 resize-none overflow-auto rounded-none border-0 bg-transparent p-4 text-sm [field-sizing:fixed] outline-none placeholder:text-zinc-400 focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 dark:placeholder:text-zinc-500"
            />
          </div>

          <aside className="flex min-h-0 flex-col gap-4 overflow-hidden">
            <div
              className={[
                "flex shrink-0 flex-col items-center justify-center rounded-md border border-dashed bg-white px-4 py-5 text-center transition-colors dark:bg-zinc-900",
                isDragging
                  ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-800"
                  : "border-zinc-300 dark:border-zinc-700",
              ].join(" ")}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                void addFiles(event.dataTransfer.files);
              }}
            >
              <Upload className="size-6 text-zinc-700 dark:text-zinc-200" />
              <p className="mt-3 text-sm font-medium">Upload images</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {images.length} / {MAX_IMAGES}, max{" "}
                {formatBytes(MAX_IMAGE_BYTES)} each
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept={ALLOWED_IMAGE_TYPES.join(",")}
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) void addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4"
                disabled={images.length >= MAX_IMAGES || status === "expired"}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload data-icon="inline-start" />
                Choose files
              </Button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <span className="text-sm font-medium">Images</span>
                <ImageIcon className="size-4 text-zinc-500 dark:text-zinc-400" />
              </div>
              <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto p-3">
                {images.length === 0 ? (
                  <div className="flex min-h-32 items-center justify-center rounded-md bg-zinc-50 text-sm text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
                    No images
                  </div>
                ) : null}

                {images.map((image) => (
                  <div
                    key={image.id}
                    className="grid grid-cols-[88px_minmax(0,1fr)_32px] gap-3 rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
                  >
                    <NextImage
                      src={image.base64}
                      alt={image.name}
                      width={88}
                      height={88}
                      unoptimized
                      className="aspect-square size-[88px] rounded object-cover"
                    />
                    <div className="min-w-0 py-1">
                      <p className="truncate text-sm font-medium">
                        {image.name}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {formatBytes(image.size)}
                      </p>
                      <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {image.mimeType}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Download ${image.name}`}
                        onClick={() => downloadImage(image)}
                      >
                        <Download />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${image.name}`}
                        disabled={status === "expired"}
                        onClick={() => removeImage(image.id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>
        <Dialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
          <DialogContent className="max-w-sm gap-4 rounded-md p-5">
            <DialogHeader className="pr-8">
              <DialogTitle>Clear text?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              This will remove all text from the current session.
            </p>
            <DialogFooter className="flex-row justify-end">
              <DialogClose
                render={<Button type="button" variant="ghost" size="sm" />}
              >
                Cancel
              </DialogClose>
              <Button
                type="button"
                size="sm"
                className={"min-w-25"}
                onClick={confirmClearText}
              >
                Clear
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {hasRemoteUpdate ? (
          <div className="fixed right-4 bottom-4 z-50 w-[min(24rem,calc(100vw-2rem))] animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="rounded-md border border-zinc-200 bg-white/95 p-3 shadow-xl shadow-zinc-950/10 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95 dark:shadow-black/30">
              <div className="flex gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                  <RotateCcw className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">New changes saved</p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    Refresh to load the latest session content.
                  </p>
                  <div className="mt-3 flex justify-end">
                    <Button type="button" size="sm" onClick={refreshSession}>
                      <RefreshCw data-icon="inline-start" />
                      Refresh
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
