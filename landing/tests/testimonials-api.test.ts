import { describe, expect, test } from 'bun:test';

import {
  getModerationStatus,
  getClientIp,
  parseSubmission,
  toAdminTestimonial,
  toPublicTestimonial,
  type TestimonialRow,
} from '../functions/api/[[path]]';

const baseRow: TestimonialRow = {
  id: 'testimonial-1',
  quote: 'Termul keeps my project terminals exactly where I need them.',
  name: 'Alex Chen',
  role: 'Staff Engineer',
  status: 'pending',
  avatar_url: 'https://example.com/avatar.png',
  avatar_r2_key: null,
  avatar_content_type: null,
  created_at: '2026-05-31T00:00:00.000Z',
  updated_at: '2026-05-31T00:00:00.000Z',
};

function submissionForm(overrides: Record<string, FormDataEntryValue> = {}) {
  const formData = new FormData();
  formData.set(
    'quote',
    'Termul keeps my project terminals exactly where I need them.',
  );
  formData.set('name', 'Alex Chen');
  formData.set('role', 'Staff Engineer');
  formData.set('avatarUrl', 'https://example.com/avatar.png');

  for (const [key, value] of Object.entries(overrides)) {
    formData.set(key, value);
  }

  return formData;
}

function expectApiError(error: unknown, status: number, message: string) {
  expect(error).toBeInstanceOf(Error);
  expect((error as { status?: number }).status).toBe(status);
  expect((error as Error).message).toBe(message);
}

describe('testimonial API helpers', () => {
  test('maps public testimonials without landing-only fields', () => {
    expect(toPublicTestimonial(baseRow)).toEqual({
      id: 'testimonial-1',
      quote: 'Termul keeps my project terminals exactly where I need them.',
      name: 'Alex Chen',
      role: 'Staff Engineer',
      avatarUrl: 'https://example.com/avatar.png',
    });
  });

  test('maps R2 avatars through the approved public avatar proxy', () => {
    expect(
      toPublicTestimonial({
        ...baseRow,
        avatar_url: null,
        avatar_r2_key: 'testimonials/avatar file.png',
      }).avatarUrl,
    ).toBe('/api/testimonials/avatar/testimonials%2Favatar%20file.png');
  });

  test('maps admin metadata without recomputing storage state in the client', () => {
    expect(
      toAdminTestimonial({
        ...baseRow,
        status: 'approved',
        avatar_url: null,
        avatar_r2_key: 'testimonials/avatar.png',
      }),
    ).toMatchObject({
      id: 'testimonial-1',
      status: 'approved',
      avatarKind: 'r2',
      createdAt: '2026-05-31T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:00.000Z',
    });
  });

  test('parses a valid submission', () => {
    expect(parseSubmission(submissionForm())).toMatchObject({
      quote: 'Termul keeps my project terminals exactly where I need them.',
      name: 'Alex Chen',
      role: 'Staff Engineer',
      avatarUrl: 'https://example.com/avatar.png',
      avatarFile: null,
    });
  });

  test('rejects invalid avatar URLs as expected client errors', () => {
    try {
      parseSubmission(submissionForm({ avatarUrl: 'not-a-url' }));
      throw new Error('Expected parseSubmission to throw');
    } catch (error) {
      expectApiError(error, 400, 'Avatar URL must be a valid URL.');
    }
  });

  test('rejects submissions without any avatar source', () => {
    const formData = submissionForm({ avatarUrl: '' });

    try {
      parseSubmission(formData);
      throw new Error('Expected parseSubmission to throw');
    } catch (error) {
      expectApiError(error, 400, 'Add an avatar upload or avatar URL.');
    }
  });

  test('rejects unsupported avatar uploads', () => {
    const file = new File(['not an image'], 'avatar.txt', {
      type: 'text/plain',
    });

    try {
      parseSubmission(submissionForm({ avatar: file, avatarUrl: '' }));
      throw new Error('Expected parseSubmission to throw');
    } catch (error) {
      expectApiError(error, 400, 'Avatar must be PNG, JPG, GIF, or WebP.');
    }
  });

  test('maps moderation route actions to statuses', () => {
    expect(getModerationStatus('approve')).toBe('approved');
    expect(getModerationStatus('reject')).toBe('rejected');
    expect(getModerationStatus('delete')).toBeNull();
    expect(getModerationStatus('unknown')).toBeNull();
  });

  test('rejects file uploads on text-only fields', () => {
    const file = new File(['Alex'], 'name.txt', { type: 'text/plain' });

    try {
      parseSubmission(submissionForm({ name: file }));
      throw new Error('Expected parseSubmission to throw');
    } catch (error) {
      expectApiError(error, 400, 'Name must be plain text.');
    }
  });

  test('uses the first forwarded IP when CF-Connecting-IP is absent', () => {
    const request = new Request('https://termul.dev/api/testimonials', {
      headers: {
        'X-Forwarded-For': '1.2.3.4, 5.6.7.8',
      },
    });

    expect(getClientIp(request)).toBe('1.2.3.4');
  });

  test('prefers CF-Connecting-IP over X-Forwarded-For', () => {
    const request = new Request('https://termul.dev/api/testimonials', {
      headers: {
        'CF-Connecting-IP': '9.9.9.9',
        'X-Forwarded-For': '1.2.3.4, 5.6.7.8',
      },
    });

    expect(getClientIp(request)).toBe('9.9.9.9');
  });
});
