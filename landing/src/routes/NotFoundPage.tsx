import { useSeoMeta } from '@unhead/react';

import { Button } from '../components/ui/Button';

export function NotFoundPage() {
  useSeoMeta({
    title: 'Page not found — Termul',
    description: 'The page you are looking for does not exist.',
    robots: 'noindex,nofollow',
  });

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center px-6 pb-24 pt-32"
    >
      <div className="mx-auto max-w-xl text-center">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mt-4 text-muted-foreground">
          The page you are looking for does not exist or has moved.
        </p>
        <div className="mt-8 flex justify-center">
          <Button as="a" href="/">
            Back to home
          </Button>
        </div>
      </div>
    </main>
  );
}
