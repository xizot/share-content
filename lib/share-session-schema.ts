export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const MAX_TEXT_LENGTH = 200_000;
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type SharedImage = {
  id: string;
  name: string;
  mimeType: string;
  base64: string;
  size: number;
  createdAt: string;
};

export type SharedSessionMeta = {
  id: string;
  text: string;
  imageIds: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revision: number;
};

export type SharedSession = SharedSessionMeta & {
  images: SharedImage[];
};

export type SessionUpdateInput = {
  text: string;
  images: SharedImage[];
};
