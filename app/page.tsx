'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/design-system/components/ui/button';

type CreateSessionResponse = {
  url: string;
};

type ErrorResponse = {
  error: string;
};

async function createSession() {
  const response = await fetch('/api/sessions', {
    method: 'POST',
  });
  const payload = (await response.json()) as CreateSessionResponse | ErrorResponse;

  if (!response.ok) {
    throw new Error('error' in payload ? payload.error : 'Unable to create session.');
  }

  if (!('url' in payload)) {
    throw new Error('Unable to create session.');
  }

  return payload.url;
}

export default function Home() {
  const [error, setError] = useState('');

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      createSession()
        .then((url) => {
          window.location.replace(url);
        })
        .catch((caughtError: unknown) => {
          setError(caughtError instanceof Error ? caughtError.message : 'Unable to create session.');
        });
    }, 0);

    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 text-zinc-950">
      <div className="flex w-full max-w-sm flex-col items-center rounded-md border border-zinc-200 bg-white p-6 text-center">
        {error ? (
          <>
            <p className="text-sm font-medium text-red-600">{error}</p>
            <Button type="button" className="mt-4" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="size-6 animate-spin text-zinc-700" />
            <p className="mt-3 text-sm text-zinc-600">Creating session...</p>
          </>
        )}
      </div>
    </main>
  );
}
