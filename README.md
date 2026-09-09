This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Sessions are stored only in process RAM, as an intentional deployment choice.
Module copies in the same process share the cache; separate Vercel instances do not.
Cold starts, restarts, and instance eviction lose sessions. The 8-hour TTL is an
upper bound, not a persistence guarantee. A missing session returns 404 rather
than creating an empty session when a share link is opened. Create/join named
sessions from the home page, or use the upsert API to explicitly create content.

Autosave waits 200 ms, serializes writes, and retries transient failures up to
three attempts with a 15-second timeout per attempt. Share link waits for save
completion. Unedited receiver pages refresh content after revision polling
(normally every 5 seconds). Concurrent edits with a stale revision return 409;
copy the local draft before refreshing to resolve the conflict.

Run session regression checks with `node --test tests/share-session.test.cjs`.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
