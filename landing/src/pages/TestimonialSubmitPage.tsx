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
          className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 shadow-2xl shadow-black/30 sm:p-8"
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
                className="resize-none rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-gray-600 focus:border-blue-400/60"
              />
            </label>

            <div className="grid gap-5 sm:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-white">Name</span>
                <input
                  name="name"
                  required
                  maxLength={80}
                  className="rounded-full border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-gray-600 focus:border-blue-400/60"
                  placeholder="Alex Chen"
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-white">Role</span>
                <input
                  name="role"
                  required
                  maxLength={120}
                  className="rounded-full border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-gray-600 focus:border-blue-400/60"
                  placeholder="Staff Engineer"
                />
              </label>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-white">
                  Avatar upload
                </span>
                <input
                  name="avatar"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="rounded-full border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-gray-300 file:mr-3 file:rounded-full file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-black"
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-white">
                  Or avatar URL
                </span>
                <input
                  name="avatarUrl"
                  type="url"
                  maxLength={500}
                  className="rounded-full border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-gray-600 focus:border-blue-400/60"
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
                  className={
                    status === 'success'
                      ? 'text-sm text-green-300'
                      : 'text-sm text-rose-300'
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
