import type { ReactNode } from 'react';
import { useHead, useSeoMeta } from '@unhead/react';

type LegalPageProps = {
  title: string;
  description: string;
  path: string;
  lastUpdated: string;
  children: ReactNode;
};

export function LegalPage({
  title,
  description,
  path,
  lastUpdated,
  children,
}: LegalPageProps) {
  useSeoMeta({
    title: `${title} — Termul`,
    description,
    robots: 'index,follow',
  });
  useHead({
    link: [{ rel: 'canonical', href: `https://termul.dev${path}` }],
  });

  return (
    <main id="main-content" className="px-6 pb-24 pt-32">
      <article className="mx-auto max-w-3xl text-muted-foreground leading-relaxed">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-3 text-sm">Last updated: {lastUpdated}</p>
        <p className="mt-6 rounded-lg border border-border-subtle p-4 text-sm">
          This page is a plain-language draft. It describes what the Termul
          website and app do today, as far as we could verify in the source
          code. It is not legal advice.
        </p>
        <div className="mt-10 grid gap-10">{children}</div>
      </article>
    </main>
  );
}

export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="grid list-disc gap-2 pl-5">{children}</ul>;
}

export function LegalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline underline-offset-4 hover:text-white"
    >
      {children}
    </a>
  );
}
