import { useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { useSeoMeta } from '@unhead/react';

import { Button } from '../components/ui/Button';
import { SectionHeader } from '../components/ui/SectionHeader';
import { readCssTime } from '../lib/read-css-time';
import { submitTestimonial } from '../lib/testimonials-api';
import { cn } from '../lib/utils';
import {
  testimonialFileInputClass,
  testimonialInputClass,
  testimonialLabelClass,
  testimonialPanelInsetClass,
  testimonialTextareaClass,
} from '../lib/testimonial-ui';

type SubmitStatus = 'idle' | 'submitting' | 'success' | 'error';

function StatusSwap({
  message,
  status,
}: {
  message: string;
  status: SubmitStatus;
}) {
  const elRef = useRef<HTMLParagraphElement>(null);
  const visibleRef = useRef(message);
  const [visible, setVisible] = useState(message);
  const [visibleStatus, setVisibleStatus] = useState(status);
  const [phase, setPhase] = useState<'idle' | 'exit' | 'enter-start'>('idle');

  useEffect(() => {
    if (message === visibleRef.current) return;

    if (!visibleRef.current) {
      flushSync(() => {
        visibleRef.current = message;
        setVisible(message);
        setVisibleStatus(status);
        setPhase('enter-start');
      });
      if (elRef.current) void elRef.current.offsetHeight;
      setPhase('idle');
      return;
    }

    const dur = readCssTime('--text-swap-dur', 150);
    setPhase('exit');

    const timer = window.setTimeout(() => {
      flushSync(() => {
        visibleRef.current = message;
        setVisible(message);
        setVisibleStatus(status);
        setPhase(message ? 'enter-start' : 'idle');
      });
      if (elRef.current) void elRef.current.offsetHeight;
      if (message) setPhase('idle');
    }, dur);

    return () => window.clearTimeout(timer);
  }, [message, status]);

  if (!visible && phase === 'idle') return null;

  return (
    <p
      ref={elRef}
      aria-atomic="true"
      aria-live="polite"
      className={cn(
        't-text-swap text-sm',
        phase === 'exit' && 'is-exit',
        phase === 'enter-start' && 'is-enter-start',
        visibleStatus === 'success' ? 'text-emerald' : 'text-warning-red',
      )}
    >
      {visible}
    </p>
  );
}

export function TestimonialSubmitPage() {
  const [status, setStatus] = useState<SubmitStatus>('idle');
  const [message, setMessage] = useState('');

  useSeoMeta({
    title: 'Submit a Termul Testimonial',
    description:
      'Share how Termul helps your workflow. Approved testimonials may appear on the Termul landing page.',
    robots: 'index,follow',
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    setStatus('submitting');
    setMessage('');

    try {
      await submitTestimonial(formData);
      form.reset();
      setStatus('success');
      setMessage('Thanks. Your testimonial is pending review.');
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not submit your testimonial. Please try again.',
      );
    }
  };

  return (
    <main id="main-content" className="px-6 pb-24 pt-32">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
        <SectionHeader
          eyebrow="Share your workflow"
          title="Tell developers how Termul helps you."
          description="Send a short testimonial with your name, role, and avatar. We review submissions before they appear publicly."
          className="lg:sticky lg:top-32"
        />

        <form
          onSubmit={handleSubmit}
          className={`p-6 shadow-2xl shadow-pitch-black/40 backdrop-blur-md sm:p-8 ${testimonialPanelInsetClass}`}
        >
          <div className="hidden" aria-hidden="true">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>

          <div className="grid gap-5">
            <label className="grid gap-2">
              <span className={testimonialLabelClass}>Quote</span>
              <textarea
                name="quote"
                required
                minLength={20}
                maxLength={500}
                rows={6}
                placeholder="Termul helps me..."
                className={testimonialTextareaClass}
              />
            </label>

            <div className="grid gap-5 sm:grid-cols-2">
              <label className="grid gap-2 min-w-0">
                <span className={testimonialLabelClass}>Name</span>
                <input
                  name="name"
                  required
                  maxLength={80}
                  className={`w-full ${testimonialInputClass}`}
                  placeholder="Alex Chen"
                />
              </label>
              <label className="grid gap-2 min-w-0">
                <span className={testimonialLabelClass}>Role</span>
                <input
                  name="role"
                  required
                  maxLength={120}
                  className={`w-full ${testimonialInputClass}`}
                  placeholder="Staff Engineer"
                />
              </label>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <label className="grid gap-2 min-w-0">
                <span className={testimonialLabelClass}>Avatar upload</span>
                <input
                  name="avatar"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className={testimonialFileInputClass}
                />
              </label>
              <label className="grid gap-2 min-w-0">
                <span className={testimonialLabelClass}>Or avatar URL</span>
                <input
                  name="avatarUrl"
                  type="url"
                  maxLength={500}
                  className={`w-full ${testimonialInputClass}`}
                  placeholder="https://..."
                />
              </label>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                type="submit"
                disabled={status === 'submitting'}
                className="disabled:pointer-events-none disabled:opacity-60"
              >
                {status === 'submitting' ? 'Submitting...' : 'Submit testimonial'}
              </Button>
              <StatusSwap message={message} status={status} />
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
