# Share Content App Plan

## Goal

Build a Vercel-deployed web app where users can share text and images through a session link. Images are converted to base64 and stored as text. No database is used. Sessions expire after 8 hours.

## Storage Strategy

Use a module-level in-memory cache (`Map`) as the storage layer.

- Session data is not stored in the URL.
- Session data is not stored in a database.
- Cache TTL is 8 hours (`28800` seconds).
- Local and self-hosted deployments keep sessions for as long as the Node.js process stays alive.
- Vercel deployments keep sessions only while the handling function instance stays warm. A cold start, redeploy, or request routed to another instance can lose access to the session.

Key format:

- Session metadata: `share:session:<sessionId>`
- Image data: `share:session:<sessionId>:image:<imageId>`

## Data Model

```ts
type SharedSession = {
  id: string;
  text: string;
  imageIds: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revision: number;
};

type SharedImage = {
  id: string;
  name: string;
  mimeType: string;
  base64: string;
  size: number;
  createdAt: string;
};
```

## Limits

The app keeps values small because in-memory cache increases process memory usage.

- Text: 200 KB max.
- Images per session: 8 max.
- Image file size: 5 MB max before base64 conversion.
- Allowed image types: PNG, JPEG, WebP, GIF.
- Session ID is validated as a short random ID.

## Routes

### Pages

- `/`: creates a new session and redirects to `/s/[sessionId]`.
- `/s/[sessionId]`: editable shared session page.
- `/s/[sessionId]` lazily creates an empty in-memory session when the ID is valid but not present in the current process cache.

### API

- `POST /api/sessions`: creates a new 8-hour session.
- `GET /api/sessions/[sessionId]`: returns session text and images.
- `PUT /api/sessions/[sessionId]`: replaces session text and image list.
- `DELETE /api/sessions/[sessionId]`: removes session metadata and image entries.

Expired sessions return `410 Gone`.

## UI Behavior

- Users can edit text in a large textarea.
- Users can upload images; the browser converts files to data URLs.
- Users can remove uploaded images.
- The app auto-saves with a short debounce.
- Viewers can use a refresh button to pull the latest session state.
- Copy link and create new session controls are available in the header.

## Deployment Notes

- Use Node.js runtime, not Edge runtime.
- API responses use `Cache-Control: no-store`.
- For self-hosting, run a single Node.js process or add sticky routing if multiple processes are used.
- On Vercel, module cache is ephemeral per function instance and should be treated as best-effort only.
