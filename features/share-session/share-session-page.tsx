"use client";

import {
  Check,
  Copy,
  Download,
  Eraser,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import NextImage from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/design-system/components/ui/badge";
import { Button } from "@/design-system/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/design-system/components/ui/dialog";
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

type ApiErrorResponse = {
  error: string;
};

type SaveStatus = "idle" | "loading" | "saving" | "saved" | "error" | "expired";

type ShareSessionPageProps = {
  sessionId: string;
};

const SAVE_DEBOUNCE_MS = 700;

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

export function ShareSessionPage({ sessionId }: ShareSessionPageProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<SharedImage[]>([]);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [message, setMessage] = useState("Loading session...");
  const [copied, setCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const latestFingerprintRef = useRef("");
  const revisionRef = useRef(0);
  const textRef = useRef("");
  const imagesRef = useRef<SharedImage[]>([]);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applySession = useCallback((session: SharedSession) => {
    setText(session.text);
    setImages(session.images);
    textRef.current = session.text;
    imagesRef.current = session.images;
    revisionRef.current = session.revision;
    latestFingerprintRef.current = getPayloadFingerprint(
      session.text,
      session.images,
    );
    dirtyRef.current = false;
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
      if (fingerprint === latestFingerprintRef.current) return;

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
      setStatus("idle");
      setMessage("");
    },
    [applySession, sessionId],
  );

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

  const updateText = (value: string) => {
    if (value.length > MAX_TEXT_LENGTH) {
      setStatus("error");
      setMessage(`Text limit is ${formatBytes(MAX_TEXT_LENGTH)}.`);
      return;
    }

    dirtyRef.current = true;
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
    const updatedImages = [...imagesRef.current, ...nextImages];
    imagesRef.current = updatedImages;
    setImages(updatedImages);
    setStatus("idle");
    setMessage("");
  };

  const removeImage = (imageId: string) => {
    dirtyRef.current = true;
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

  return (
    <main className="h-screen overflow-hidden bg-zinc-50 text-zinc-950">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex shrink-0 flex-col gap-4 border-b border-zinc-200 pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-normal">
                Share Content
              </h1>
              <Badge
                variant="outline"
                className="max-w-full rounded-md font-sans"
              >
                {sessionId}
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size={"sm"}
              variant="outline"
              onClick={copyLink}
            >
              {copied ? (
                <Check data-icon="inline-start" />
              ) : (
                <Copy data-icon="inline-start" />
              )}
              {copied ? "Copied" : "Copy link"}
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
          <div className="flex min-h-0 flex-col rounded-md border border-zinc-200 bg-white">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
              <span className="text-sm font-medium">Text</span>
              <div className="flex items-center gap-1">
                <span className="mr-2 text-xs text-zinc-500">
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
              placeholder="Paste text here..."
              disabled={status === "expired"}
              className="min-h-0 flex-1 resize-none overflow-auto rounded-none border-0 bg-transparent p-4 text-sm [field-sizing:fixed] outline-none placeholder:text-zinc-400 focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <aside className="flex min-h-0 flex-col gap-4 overflow-hidden">
            <div
              className={[
                "flex shrink-0 flex-col items-center justify-center rounded-md border border-dashed bg-white px-4 py-5 text-center transition-colors",
                isDragging ? "border-zinc-900 bg-zinc-100" : "border-zinc-300",
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
              <Upload className="size-6 text-zinc-700" />
              <p className="mt-3 text-sm font-medium">Upload images</p>
              <p className="mt-1 text-xs text-zinc-500">
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

            <div className="flex min-h-0 flex-1 flex-col rounded-md border border-zinc-200 bg-white">
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3">
                <span className="text-sm font-medium">Images</span>
                <ImageIcon className="size-4 text-zinc-500" />
              </div>
              <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto p-3">
                {images.length === 0 ? (
                  <div className="flex min-h-32 items-center justify-center rounded-md bg-zinc-50 text-sm text-zinc-500">
                    No images
                  </div>
                ) : null}

                {images.map((image) => (
                  <div
                    key={image.id}
                    className="grid grid-cols-[88px_minmax(0,1fr)_32px] gap-3 rounded-md border border-zinc-200 p-2"
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
                      <p className="mt-1 text-xs text-zinc-500">
                        {formatBytes(image.size)}
                      </p>
                      <p className="mt-1 truncate text-xs text-zinc-500">
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
            <p className="text-sm text-zinc-600">
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
        {message ? (
          <div className="fixed right-4 bottom-4 z-50 max-w-[min(22rem,calc(100vw-2rem))] rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 shadow-lg">
            {message}
          </div>
        ) : null}
      </div>
    </main>
  );
}
