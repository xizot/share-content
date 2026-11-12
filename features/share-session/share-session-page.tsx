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
  Send,
  Share2,
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
import { isValidCurl } from "@/lib/curl";

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
type SendStatus = "idle" | "sending" | "success" | "error";

type ExecuteCurlResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
};

type ShareSessionPageProps = {
  sessionId: string;
};

const SAVE_DEBOUNCE_MS = 200;
const REVISION_POLL_MS = 5000;

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
  if (message === "Session not found.")
    return "Session not found or no longer available. Your draft has not been saved.";
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "Request timed out. Please retry.";
  return message;
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

function getFormatKind(value: string): "json" | "curl" | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;

  try {
    JSON.parse(trimmedValue);
    return "json";
  } catch {
    return /^curl(?:\s|$)/i.test(trimmedValue) ? "curl" : null;
  }
}

const CURL_BODY_OPTIONS = new Set([
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "-d",
]);

function formatCurlBody(option: string, value: string) {
  if (!CURL_BODY_OPTIONS.has(option.toLowerCase())) {
    return `${option} ${value}`;
  }

  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) {
    return `${option} ${value}`;
  }

  try {
    const body = JSON.parse(value.slice(1, -1)) as unknown;
    const formattedBody = JSON.stringify(body, null, 2).replace(/\n/g, "\n  ");
    return `${option} ${quote}${formattedBody}${quote}`;
  } catch {
    return `${option} ${value}`;
  }
}

function formatCurl(value: string) {
  const normalizedValue = value
    .trim()
    .replace(/\\\s*\r?\n\s*/g, " ")
    .replace(/\s+/g, " ");
  const tokens = normalizedValue.match(
    /(?:[^\s"'\\]|\\.|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g,
  );

  if (!tokens || tokens[0].toLowerCase() !== "curl") return value;

  const lines = [tokens[0]];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];

    if (token.startsWith("-") && nextToken && !nextToken.startsWith("-")) {
      lines.push(`  ${formatCurlBody(token, nextToken)}`);
      index += 1;
    } else {
      lines.push(`  ${token}`);
    }
  }

  return lines.join(" \\\n");
}

function formatContent(value: string) {
  const formatKind = getFormatKind(value);
  if (!formatKind) return value;

  return formatKind === "json"
    ? JSON.stringify(JSON.parse(value.trim()), null, 2)
    : formatCurl(value);
}

export function ShareSessionPage({ sessionId }: ShareSessionPageProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<SharedImage[]>([]);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [message, setMessage] = useState("Loading session...");
  const [copied, setCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [hasRemoteUpdate, setHasRemoteUpdate] = useState(false);
  const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
  const [sendError, setSendError] = useState("");
  const [sendResponse, setSendResponse] = useState<ExecuteCurlResponse | null>(
    null,
  );
  const [responseDialogOpen, setResponseDialogOpen] = useState(false);

  const latestFingerprintRef = useRef("");
  const revisionRef = useRef(0);
  const updatedAtRef = useRef("");
  const textRef = useRef("");
  const imagesRef = useRef<SharedImage[]>([]);
  const dirtyRef = useRef(false);
  const remoteUpdateRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const savedImagesRef = useRef<SharedImage[]>([]);
  const [loaded, setLoaded] = useState(false);

  const applySession = useCallback((session: SharedSession) => {
    setText(session.text);
    setImages(session.images);
    textRef.current = session.text;
    imagesRef.current = session.images;
    savedImagesRef.current = session.images;
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
      const revisionAtStart = revisionRef.current;
      if (mode === "initial") {
        setStatus("loading");
        setMessage("Loading session...");
      } else {
        setMessage("Refreshing...");
      }

      const fetchSession = () =>
        fetch(`/api/sessions/${sessionId}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        });
      let response = await fetchSession();
      if (response.status === 404 && mode === "initial") {
        // Unknown on this instance: (re)create it, then load again.
        await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
          signal: AbortSignal.timeout(15000),
        });
        response = await fetchSession();
      }
      const payload = await parseApiResponse<ApiSessionResponse>(response);

      if (
        dirtyRef.current ||
        saveInFlightRef.current ||
        revisionRef.current !== revisionAtStart
      ) {
        setStatus("idle");
        setMessage("Save current changes before refreshing.");
        return;
      }

      applySession(payload.session);
      setLoaded(true);
      setStatus("saved");
      setMessage("Saved");
    },
    [applySession, sessionId],
  );

  const saveSession = useCallback(async () => {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const operation = (async () => {
      while (dirtyRef.current) {
        const nextText = textRef.current;
        const nextImages = imagesRef.current;
        const fingerprint = getPayloadFingerprint(nextText, nextImages);
        if (fingerprint === latestFingerprintRef.current) {
          dirtyRef.current = false;
          setHasUnsavedChanges(false);
          setStatus("saved");
          setMessage("Saved");
          return;
        }

        setStatus("saving");
        setMessage("Saving...");

        let payload: ApiSessionResponse | undefined;
        // When the server no longer has the session (cold start, another
        // instance), recreate it from the local draft instead of failing.
        let recreate = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const response = await fetch(`/api/sessions/${sessionId}`, {
              method: "PUT",
              signal: AbortSignal.timeout(15000),
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(
                recreate
                  ? { text: nextText, images: nextImages }
                  : {
                      text: nextText,
                      images:
                        nextImages === savedImagesRef.current
                          ? undefined
                          : nextImages,
                      revision: revisionRef.current,
                    },
              ),
            });
            if (response.status === 404 && !recreate) {
              recreate = true;
              continue;
            }
            if (response.status >= 400 && response.status < 500) {
              const failure = await response.json();
              throw new Error(failure.error || "Unable to save session.", {
                cause: "permanent",
              });
            }
            payload = await parseApiResponse<ApiSessionResponse>(response);
            break;
          } catch (error) {
            if (
              attempt === 2 ||
              (error instanceof Error && error.cause === "permanent")
            )
              throw error;
            await new Promise((resolve) =>
              window.setTimeout(resolve, 500 * 2 ** attempt),
            );
          }
        }
        if (!payload) throw new Error("Unable to save session.");
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
        latestFingerprintRef.current = fingerprint;
        savedImagesRef.current = nextImages;
        setStatus("idle");
        setMessage("");
      }
    })();
    saveInFlightRef.current = operation;
    try {
      await operation;
    } finally {
      saveInFlightRef.current = null;
    }
  }, [applySession, sessionId]);

  const saveCurrentSession = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    await saveSession();
  }, [saveSession]);

  const createNewSession = useCallback(async () => {
    await saveCurrentSession();
    setStatus("loading");
    setMessage("Creating session...");

    const response = await fetch("/api/sessions", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
    });
    const payload = await parseApiResponse<{ url: string }>(response);
    window.location.assign(payload.url);
  }, [saveCurrentSession]);

  const retrySave = useCallback(() => {
    void saveCurrentSession().catch((error: unknown) => {
      setStatus("error");
      setMessage(getDisplayMessage(error, "Unable to save session."));
    });
  }, [saveCurrentSession]);

  useEffect(() => {
    window.addEventListener("online", retrySave);
    return () => window.removeEventListener("online", retrySave);
  }, [retrySave]);

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
    if (
      !loaded ||
      !dirtyRef.current ||
      fingerprint === latestFingerprintRef.current
    )
      return;

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      saveSession().catch((error: unknown) => {
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
  }, [images, loaded, saveSession, text]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "s"
      ) {
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
          signal: AbortSignal.timeout(15000),
        });
        const payload =
          await parseApiResponse<ApiSessionRevisionResponse>(response);

        const hasNewerRevision = payload.session.revision > revisionRef.current;
        const hasNewerTimestamp =
          Boolean(updatedAtRef.current) &&
          payload.session.updatedAt !== updatedAtRef.current;

        if (
          (hasNewerRevision || hasNewerTimestamp) &&
          !remoteUpdateRef.current
        ) {
          if (!dirtyRef.current && !saveInFlightRef.current) {
            await loadSession("manual");
            return;
          }
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
  }, [hasRemoteUpdate, loadSession, sessionId, status]);

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
    if (!loaded || status === "expired") return;
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

  const formatText = () => {
    const formattedText = formatContent(textRef.current);

    if (formattedText !== textRef.current) {
      updateText(formattedText);
    }
  };

  const sendCurl = async () => {
    setSendStatus("sending");
    setSendError("");
    setSendResponse(null);

    try {
      const response = await fetch("/api/execute-curl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ curl: textRef.current }),
      });
      const payload = await parseApiResponse<ExecuteCurlResponse>(response);
      setSendResponse(payload);
      setSendStatus("success");
    } catch (error: unknown) {
      setSendStatus("error");
      setSendError(
        error instanceof Error ? error.message : "Unable to send cURL request.",
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
    try {
      await saveCurrentSession();
      const shareUrl = `${window.location.origin}/s/${sessionId}`;
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      setStatus("error");
      setMessage(
        getDisplayMessage(error, "Unable to save or copy share link."),
      );
    }
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
              disabled={!loaded}
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
            <Button
              type="button"
              size={"sm"}
              onClick={() =>
                void createNewSession().catch((error: unknown) => {
                  setStatus("error");
                  setMessage(
                    getDisplayMessage(error, "Unable to create session."),
                  );
                })
              }
            >
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
                {status === "error" && hasUnsavedChanges && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={retrySave}
                  >
                    Retry save
                  </Button>
                )}
                <span className="mr-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {text.length.toLocaleString()} /{" "}
                  {MAX_TEXT_LENGTH.toLocaleString()}
                </span>
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
              onBlur={formatText}
              onPaste={() => window.setTimeout(formatText, 0)}
              placeholder="Paste text here..."
              disabled={!loaded || status === "expired"}
              className="min-h-0 flex-1 resize-none overflow-auto rounded-none border-0 bg-transparent p-4 text-sm [field-sizing:fixed] outline-none placeholder:text-zinc-400 focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 dark:placeholder:text-zinc-500"
            />
            {isValidCurl(text) && (
              <div className="flex shrink-0 flex-col gap-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <div className="flex items-center justify-between gap-3">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void sendCurl()}
                    disabled={status === "expired" || sendStatus === "sending"}
                  >
                    <Send data-icon="inline-start" />
                    {sendStatus === "sending" ? "Sending..." : "Send"}
                  </Button>
                  {sendStatus === "success" && sendResponse && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        HTTP {sendResponse.status} {sendResponse.statusText}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setResponseDialogOpen(true)}
                      >
                        View response
                      </Button>
                    </div>
                  )}
                  {sendStatus === "error" && (
                    <span className="text-xs text-red-600 dark:text-red-400">
                      {sendError}
                    </span>
                  )}
                </div>
              </div>
            )}
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
        <Dialog open={responseDialogOpen} onOpenChange={setResponseDialogOpen}>
          <DialogContent className="max-h-[85vh] max-w-4xl gap-4 rounded-md p-5">
            <DialogHeader className="pr-8">
              <DialogTitle>
                Response
                {sendResponse
                  ? ` · HTTP ${sendResponse.status} ${sendResponse.statusText}`
                  : ""}
              </DialogTitle>
            </DialogHeader>
            {sendResponse && (
              <div className="min-h-0 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-700 dark:bg-zinc-950">
                <pre className="whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">
                  {sendResponse.body || "(empty response)"}
                </pre>
                {sendResponse.truncated && (
                  <p className="mt-2 text-amber-600 dark:text-amber-400">
                    Response truncated at 200 KB.
                  </p>
                )}
              </div>
            )}
            <DialogFooter className="flex-row justify-end">
              <DialogClose
                render={<Button type="button" variant="ghost" size="sm" />}
              >
                Close
              </DialogClose>
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
