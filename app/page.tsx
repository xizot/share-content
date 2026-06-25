'use client';

import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/design-system/components/ui/button';
import { Input } from '@/design-system/components/ui/input';

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
  const router = useRouter();
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleContinue = async () => {
    const nextSessionId = sessionId.trim();

    if (nextSessionId) {
      router.push(`/s/${encodeURIComponent(nextSessionId)}`);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const url = await createSession();
      window.location.assign(url);
    } catch (caughtError: unknown) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to create session.');
      setLoading(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-50 px-4 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(to_right,rgba(24,24,27,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(24,24,27,0.08)_1px,transparent_1px)] bg-[size:32px_32px] [mask-image:radial-gradient(ellipse_at_center,black_0%,black_45%,transparent_78%)] dark:bg-[linear-gradient(to_right,rgba(244,244,245,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(244,244,245,0.08)_1px,transparent_1px)]"
      />
      <section className="relative w-full max-w-md animate-in fade-in slide-in-from-bottom-3 duration-500">
        <div className="mb-5">
          <h1 className="text-3xl font-semibold tracking-normal">Share Content</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Enter a session ID, or leave it blank to create one.
          </p>
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-zinc-200/80 bg-white/85 p-2 shadow-sm backdrop-blur-sm dark:border-zinc-800/80 dark:bg-zinc-900/85 sm:flex-row">
          <Input
            value={sessionId}
            onChange={(event) => {
              setSessionId(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleContinue();
              }
            }}
            placeholder="Session ID"
            aria-label="Session ID"
            className="h-11 border-transparent bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <Button
            type="button"
            size="lg"
            loading={loading}
            className="sm:min-w-32"
            onClick={handleContinue}
          >
            <ArrowRight data-icon="inline-start" />
            Continue
          </Button>
        </div>

        {error ? <p className="mt-3 text-sm font-medium text-red-600">{error}</p> : null}
      </section>
    </main>
  );
}
