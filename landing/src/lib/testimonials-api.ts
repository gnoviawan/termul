import type {
  AdminTestimonial,
  PublicTestimonial,
  TestimonialSubmitResponse,
} from '../types/testimonials';

export type ModerationAction = 'approve' | 'reject' | 'delete';

const jsonHeaders = {
  Accept: 'application/json',
} as const;

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;

  if (!response.ok) {
    throw new Error(
      payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        payload.error
        ? payload.error
        : 'Request failed',
    );
  }

  return payload as T;
}

export async function fetchApprovedTestimonials(): Promise<PublicTestimonial[]> {
  const response = await fetch('/api/testimonials', {
    headers: jsonHeaders,
  });
  const payload = await parseJsonResponse<{ testimonials: PublicTestimonial[] }>(
    response,
  );

  return payload.testimonials;
}

export async function submitTestimonial(
  formData: FormData,
): Promise<TestimonialSubmitResponse> {
  const response = await fetch('/api/testimonials', {
    method: 'POST',
    body: formData,
    headers: jsonHeaders,
  });

  return parseJsonResponse<TestimonialSubmitResponse>(response);
}

export async function fetchAdminTestimonials(
  token: string,
): Promise<AdminTestimonial[]> {
  const response = await fetch('/api/admin/testimonials', {
    headers: {
      ...jsonHeaders,
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await parseJsonResponse<{ testimonials: AdminTestimonial[] }>(
    response,
  );

  return payload.testimonials;
}

export async function moderateTestimonial(
  id: string,
  action: ModerationAction,
  token: string,
): Promise<void> {
  const response = await fetch(`/api/admin/testimonials/${id}/${action}`, {
    method: action === 'delete' ? 'DELETE' : 'POST',
    headers: {
      ...jsonHeaders,
      Authorization: `Bearer ${token}`,
    },
  });

  await parseJsonResponse<{ ok: true }>(response);
}

export async function fetchAdminAvatar(
  id: string,
  token: string,
): Promise<Blob> {
  const response = await fetch(`/api/admin/testimonials/${id}/avatar`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error('Could not load avatar.');
  }

  return response.blob();
}
