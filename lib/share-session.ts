import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TEXT_LENGTH,
  SESSION_TTL_SECONDS,
  type SessionUpdateInput,
  type SharedImage,
  type SharedSession,
  type SharedSessionMeta,
} from './share-session-schema';

export {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TEXT_LENGTH,
  SESSION_TTL_SECONDS,
  type SessionUpdateInput,
  type SharedImage,
  type SharedSession,
  type SharedSessionMeta,
};

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

type CacheSetOptions = {
  ttl?: number;
};

type ModuleCache = {
  delete: (key: string) => Promise<void>;
  get: (key: string) => Promise<unknown | null>;
  set: (key: string, value: unknown, options?: CacheSetOptions) => Promise<void>;
};

type MemoryCacheEntry = {
  value: unknown;
  expiresAt?: number;
};

const memoryCache = new Map<string, MemoryCacheEntry>();

const cache: ModuleCache = {
  async get(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      memoryCache.delete(key);
      return null;
    }

    return entry.value;
  },
  async set(key, value, options) {
    memoryCache.set(key, {
      value,
      expiresAt: options?.ttl ? Date.now() + options.ttl * 1000 : undefined,
    });
  },
  async delete(key) {
    memoryCache.delete(key);
  },
};

function getSessionKey(sessionId: string) {
  return `share:session:${sessionId}`;
}

function getImageKey(sessionId: string, imageId: string) {
  return `${getSessionKey(sessionId)}:image:${imageId}`;
}

function getRemainingTtl(expiresAt: string) {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

function createCacheOptions(expiresAt: string): CacheSetOptions {
  return {
    ttl: getRemainingTtl(expiresAt),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSharedSessionMeta(value: unknown): value is SharedSessionMeta {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    Array.isArray(value.imageIds) &&
    value.imageIds.every((id) => typeof id === 'string') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    typeof value.revision === 'number'
  );
}

function isSharedImage(value: unknown): value is SharedImage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.base64 === 'string' &&
    typeof value.size === 'number' &&
    typeof value.createdAt === 'string'
  );
}

function assertValidSessionId(sessionId: string) {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ShareSessionError('Invalid session ID.', 400);
  }
}

function assertValidImage(image: SharedImage) {
  if (!SESSION_ID_PATTERN.test(image.id)) {
    throw new ShareSessionError('Invalid image ID.', 400);
  }

  if (!ALLOWED_IMAGE_TYPES.includes(image.mimeType as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    throw new ShareSessionError('Unsupported image type.', 400);
  }

  if (image.name.length > 160) {
    throw new ShareSessionError('Image name is too long.', 400);
  }

  if (!Number.isFinite(image.size) || image.size < 0 || image.size > MAX_IMAGE_BYTES) {
    throw new ShareSessionError('Image is too large.', 413);
  }

  if (!image.base64.startsWith(`data:${image.mimeType};base64,`)) {
    throw new ShareSessionError('Invalid image data.', 400);
  }

  const base64Payload = image.base64.split(',', 2)[1] ?? '';
  const estimatedBytes = Math.floor((base64Payload.length * 3) / 4);
  if (estimatedBytes > MAX_IMAGE_BYTES) {
    throw new ShareSessionError('Image is too large.', 413);
  }
}

export class ShareSessionError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ShareSessionError';
    this.status = status;
  }
}

export function isShareSessionError(error: unknown): error is ShareSessionError {
  return error instanceof ShareSessionError;
}

export function createSessionId() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 20);
}

export async function createSharedSession(sessionId = createSessionId()) {
  assertValidSessionId(sessionId);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const session: SharedSessionMeta = {
    id: sessionId,
    text: '',
    imageIds: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt,
    revision: 0,
  };

  await cache.set(getSessionKey(session.id), session, createCacheOptions(expiresAt));

  return session;
}

export async function getOrCreateSharedSession(sessionId: string): Promise<SharedSession> {
  try {
    return await getSharedSession(sessionId);
  } catch (error) {
    if (isShareSessionError(error) && error.status === 404) {
      const session = await createSharedSession(sessionId);
      return {
        ...session,
        images: [],
      };
    }

    throw error;
  }
}

export async function getSharedSessionRevision(sessionId: string) {
  assertValidSessionId(sessionId);

  const meta = await cache.get(getSessionKey(sessionId));
  if (!isSharedSessionMeta(meta)) {
    throw new ShareSessionError('Session not found.', 404);
  }

  if (getRemainingTtl(meta.expiresAt) <= 0) {
    await deleteSharedSession(sessionId, meta);
    throw new ShareSessionError('Session expired.', 410);
  }

  return {
    id: meta.id,
    revision: meta.revision,
    updatedAt: meta.updatedAt,
    expiresAt: meta.expiresAt,
  };
}

export async function getSharedSession(sessionId: string): Promise<SharedSession> {
  assertValidSessionId(sessionId);

  const meta = await cache.get(getSessionKey(sessionId));
  if (!isSharedSessionMeta(meta)) {
    throw new ShareSessionError('Session not found.', 404);
  }

  if (getRemainingTtl(meta.expiresAt) <= 0) {
    await deleteSharedSession(sessionId, meta);
    throw new ShareSessionError('Session expired.', 410);
  }

  const images = await Promise.all(
    meta.imageIds.map(async (imageId) => {
      const image = await cache.get(getImageKey(sessionId, imageId));
      return isSharedImage(image) ? image : null;
    }),
  );

  return {
    ...meta,
    images: images.filter((image): image is SharedImage => image !== null),
  };
}

export async function updateSharedSession(sessionId: string, input: SessionUpdateInput) {
  assertValidSessionId(sessionId);

  if (input.text.length > MAX_TEXT_LENGTH) {
    throw new ShareSessionError('Text is too long.', 413);
  }

  if (input.images.length > MAX_IMAGES) {
    throw new ShareSessionError('Too many images.', 413);
  }

  input.images.forEach(assertValidImage);

  const current = await getOrCreateSharedSession(sessionId);
  const ttl = getRemainingTtl(current.expiresAt);
  if (ttl <= 0) {
    throw new ShareSessionError('Session expired.', 410);
  }

  const nextMeta: SharedSessionMeta = {
    id: current.id,
    text: input.text,
    imageIds: input.images.map((image) => image.id),
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    expiresAt: current.expiresAt,
    revision: current.revision + 1,
  };

  const nextImageIds = new Set(nextMeta.imageIds);
  const removedImageIds = current.imageIds.filter((imageId) => !nextImageIds.has(imageId));
  await Promise.all(removedImageIds.map((imageId) => cache.delete(getImageKey(sessionId, imageId))));

  const options = createCacheOptions(current.expiresAt);
  await Promise.all(
    input.images.map((image) => cache.set(getImageKey(sessionId, image.id), image, options)),
  );
  await cache.set(getSessionKey(sessionId), nextMeta, options);

  return {
    ...nextMeta,
    images: input.images,
  };
}

export async function deleteSharedSession(sessionId: string, knownMeta?: SharedSessionMeta) {
  assertValidSessionId(sessionId);

  const meta = knownMeta ?? (await cache.get(getSessionKey(sessionId)));
  if (isSharedSessionMeta(meta)) {
    await Promise.all(meta.imageIds.map((imageId) => cache.delete(getImageKey(sessionId, imageId))));
  }

  await cache.delete(getSessionKey(sessionId));
}
