import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSeoMeta } from '@unhead/react';

import { Button } from '../components/ui/Button';
import { SectionHeader } from '../components/ui/SectionHeader';
import {
  fetchAdminAvatar,
  fetchAdminTestimonials,
  moderateTestimonial,
  type ModerationAction,
} from '../lib/testimonials-api';
import {
  testimonialInputClass,
  testimonialLabelClass,
  testimonialPanelClass,
} from '../lib/testimonial-ui';
import type { AdminTestimonial, TestimonialStatus } from '../types/testimonials';

const SESSION_TOKEN_KEY = 'termul:testimonial-admin-token';
type LoadStatus = 'idle' | 'loading' | 'error';
const statusMeta: Record<
  TestimonialStatus,
  { label: string; className: string }
> = {
  pending: {
    label: 'Pending review',
    className: 'border-aether-blue/20 bg-aether-blue/10 text-light-steel',
  },
  approved: {
    label: 'Approved',
    className: 'border-emerald/20 bg-emerald/10 text-emerald',
  },
  rejected: {
    label: 'Rejected',
    className: 'border-warning-red/20 bg-warning-red/10 text-warning-red',
  },
};

export function TestimonialListPage() {
  const initialToken =
    typeof window === 'undefined'
      ? ''
      : sessionStorage.getItem(SESSION_TOKEN_KEY) ?? '';
  const [token, setToken] = useState(initialToken);
  const [testimonials, setTestimonials] = useState<AdminTestimonial[]>([]);
  const [status, setStatus] = useState<LoadStatus>(
    initialToken ? 'loading' : 'idle',
  );
  const [message, setMessage] = useState('');

  useSeoMeta({
    title: 'Termul Testimonial CMS',
    description: 'Token-protected moderation queue for Termul testimonials.',
    robots: 'noindex,nofollow',
  });

  const applyLoadFailure = useCallback((error: unknown) => {
    setStatus('error');
    setMessage(
      error instanceof Error ? error.message : 'Could not load testimonials.',
    );
  }, []);

  const refreshTestimonials = useCallback(
    async (activeToken: string) => {
      if (!activeToken) return;

      setStatus('loading');
      setMessage('');

      try {
        const nextTestimonials = await fetchAdminTestimonials(activeToken);
        setTestimonials(nextTestimonials);
        setStatus('idle');
      } catch (error) {
        applyLoadFailure(error);
      }
    },
    [applyLoadFailure],
  );

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    void fetchAdminTestimonials(token)
      .then((nextTestimonials) => {
        if (cancelled) return;
        setTestimonials(nextTestimonials);
        setStatus('idle');
      })
      .catch((error) => {
        if (cancelled) return;
        applyLoadFailure(error);
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadFailure, token]);

  const handleTokenSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextToken = String(formData.get('token') ?? '').trim();

    sessionStorage.setItem(SESSION_TOKEN_KEY, nextToken);
    setStatus('loading');
    setToken(nextToken);
  };

  const handleClearToken = () => {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    setToken('');
    setTestimonials([]);
  };

  const handleModeration = async (
    id: string,
    action: ModerationAction,
  ) => {
    setMessage('');

    try {
      await moderateTestimonial(id, action, token);
      await refreshTestimonials(token);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not update testimonial.',
      );
    }
  };

  return (
    <main id="main-content" className="px-6 pb-24 pt-32">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <SectionHeader
            eyebrow="Private CMS"
            title="Moderate Termul testimonials."
            description="Review pending submissions before they appear on the public landing page."
            className="max-w-2xl"
          />
          {token && (
            <Button type="button" variant="dark" onClick={handleClearToken}>
              Clear token
            </Button>
          )}
        </div>

        {!token ? (
          <form
            onSubmit={handleTokenSubmit}
            className={`max-w-xl p-6 sm:p-8 ${testimonialPanelClass}`}
          >
            <label className="grid gap-2">
              <span className={testimonialLabelClass}>Admin token</span>
              <input
                name="token"
                required
                type="password"
                autoComplete="off"
                className={`${testimonialInputClass} focus:border-aether-blue/60 focus:ring-aether-blue/10`}
                placeholder="Paste token"
              />
            </label>
            <Button type="submit" className="mt-5">
              Continue
            </Button>
          </form>
        ) : (
          <section className="grid gap-4">
            {status === 'loading' && (
              <p className="text-sm text-muted-foreground">Loading submissions...</p>
            )}
            {message && <p className="text-sm text-warning-red">{message}</p>}
            {testimonials.length === 0 && status !== 'loading' ? (
              <div className={`p-8 text-muted-foreground ${testimonialPanelClass}`}>
                No testimonial submissions yet.
              </div>
            ) : (
              testimonials.map((testimonial) => (
                <TestimonialModerationCard
                  key={testimonial.id}
                  testimonial={testimonial}
                  token={token}
                  onModerate={handleModeration}
                />
              ))
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function TestimonialModerationCard({
  testimonial,
  token,
  onModerate,
}: {
  testimonial: AdminTestimonial;
  token: string;
  onModerate: (
    id: string,
    action: ModerationAction,
  ) => Promise<void>;
}) {
  const status = statusMeta[testimonial.status];

  return (
    <article
      className={`grid gap-5 p-5 transition-colors hover:border-porcelain/20 sm:grid-cols-[auto_1fr] sm:p-6 ${testimonialPanelClass}`}
    >
      <AdminAvatar testimonial={testimonial} token={token} />
      <div className="grid gap-4">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${status.className}`}
            >
              {status.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(testimonial.createdAt).toLocaleString()}
            </span>
          </div>
          <blockquote className="text-lg leading-relaxed text-foreground">
            "{testimonial.quote}"
          </blockquote>
          <p className="mt-3 text-sm text-muted-foreground">
            {testimonial.name}, {testimonial.role}
          </p>
        </div>
        <ModerationActions testimonial={testimonial} onModerate={onModerate} />
      </div>
    </article>
  );
}

function ModerationActions({
  testimonial,
  onModerate,
}: {
  testimonial: AdminTestimonial;
  onModerate: (
    id: string,
    action: ModerationAction,
  ) => Promise<void>;
}) {
  const runAction = (action: ModerationAction) => {
    void onModerate(testimonial.id, action);
  };

  return (
    <div className="flex flex-wrap gap-2">
      {testimonial.status !== 'approved' && (
        <Button type="button" size="sm" onClick={() => runAction('approve')}>
          {testimonial.status === 'rejected' ? 'Restore' : 'Approve'}
        </Button>
      )}
      {testimonial.status !== 'rejected' && (
        <Button
          type="button"
          size="sm"
          variant="dark"
          onClick={() => runAction('reject')}
        >
          {testimonial.status === 'approved' ? 'Unpublish' : 'Reject'}
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="dark"
        onClick={() => runAction('delete')}
      >
        Delete
      </Button>
    </div>
  );
}

function AdminAvatar({
  testimonial,
  token,
}: {
  testimonial: AdminTestimonial;
  token: string;
}) {
  const [imageUrl, setImageUrl] = useState(() =>
    testimonial.avatarKind === 'url' ? testimonial.avatarUrl : '',
  );

  useEffect(() => {
    if (testimonial.avatarKind !== 'r2') return;

    let objectUrl = '';
    let cancelled = false;

    void fetchAdminAvatar(testimonial.id, token)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setImageUrl('');
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [testimonial.avatarKind, testimonial.id, testimonial.avatarUrl, token]);

  if (!imageUrl) {
    return (
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border-subtle bg-porcelain/5 text-sm text-muted-foreground">
        {testimonial.name.charAt(0)}
      </div>
    );
  }

  return (
    <img
      src={imageUrl}
      alt={`${testimonial.name}'s avatar`}
      className="h-14 w-14 rounded-full border border-border-subtle object-cover"
      loading="lazy"
    />
  );
}
