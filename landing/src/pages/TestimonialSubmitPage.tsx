import { useState, type FormEvent } from 'react';
import { useSeoMeta } from '@unhead/react';

import { Button } from '../components/Button';
import { SectionHeader } from '../components/SectionHeader';
import { submitTestimonial } from '../lib/testimonials-api';

export function TestimonialSubmitPage() {
  const [status, setStatus] = useState<
    'idle' | 'submitting' | 'success' | 'error'
  >('idle');
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
          className="rounded-3xl border border-white/10 bg-white/[0.02] p-6 shadow-2xl shadow-black/40 backdrop-blur-md sm:p-8"
        >
          <div className="hidden" aria-hidden="true">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>

          <div className="grid gap-5">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-white">Quote</span>
              <textarea
                name="quote"
                required
                minLength={20}
                maxLength={500}
                rows={6}
                placeholder="Termul helps me..."
                className="resize-none rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition-[border-color,background-color,box-shadow] duration-200 ease-[var(--ease-out)] hover:border-white/20 hover:bg-black/60 focus:border-white/30 focus:bg-white/[0.03] focus:ring-4 focus:ring-white/5 placeholder:text-gray-600"
              />
            </label>

            <div className="grid gap-5 sm:grid-cols-2">
              <label className="grid gap-2 min-w-0">
                <span className="text-sm font-medium text-white">Name</span>
                <input
                  name="name"
                  required
                  maxLength={80}
                  className="w-full rounded-full border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition-[border-color,background-color,box-shadow] duration-200 ease-[var(--ease-out)] hover:border-white/20 hover:bg-black/60 focus:border-white/30 focus:bg-white/[0.03] focus:ring-4 focus:ring-white/5 placeholder:text-gray-600"
                  placeholder="Alex Chen"
                />
              </label>
              <label className="grid gap-2 min-w-0">
                <span className="text-sm font-medium text-white">Role</span>
                <input
                  name="role"
                  required
                  maxLength={120}
                  className="w-full rounded-full border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition-[border-color,background-color,box-shadow] duration-200 ease-[var(--ease-out)] hover:border-white/20 hover:bg-black/60 focus:border-white/30 focus:bg-white/[0.03] focus:ring-4 focus:ring-white/5 placeholder:text-gray-600"
                  placeholder="Staff Engineer"
                />
              </label>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <label className="grid gap-2 min-w-0">
                <span className="text-sm font-medium text-white">
                  Avatar upload
                </span>
                <input
                  name="avatar"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="w-full min-w-0 cursor-pointer rounded-full border border-white/10 bg-black/40 py-2 pl-2 pr-4 text-sm text-gray-300 outline-none transition-[border-color,background-color,box-shadow] duration-200 ease-[var(--ease-out)] hover:border-white/20 hover:bg-black/60 focus-within:border-white/30 focus-within:bg-white/[0.03] focus-within:ring-4 focus-within:ring-white/5 file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-white/10 file:px-4 file:py-1.5 file:text-sm file:font-medium file:text-white file:transition-colors file:hover:bg-white/20"
                />
              </label>
              <label className="grid gap-2 min-w-0">
                <span className="text-sm font-medium text-white">
                  Or avatar URL
                </span>
                <input
                  name="avatarUrl"
                  type="url"
                  maxLength={500}
                  className="w-full rounded-full border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition-[border-color,background-color,box-shadow] duration-200 ease-[var(--ease-out)] hover:border-white/20 hover:bg-black/60 focus:border-white/30 focus:bg-white/[0.03] focus:ring-4 focus:ring-white/5 placeholder:text-gray-600"
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
              {message && (
                <p
                  aria-atomic="true"
                  aria-live="polite"
                  className={
                    status === 'success'
                      ? 'text-sm text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300 ease-[var(--ease-out)] fill-mode-both'
                      : 'text-sm text-rose-300 animate-in fade-in slide-in-from-bottom-1 duration-300 ease-[var(--ease-out)] fill-mode-both'
                  }
                >
                  {message}
                </p>
              )}
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
