// ─── Types ────────────────────────────────────────────────────────────────────

export type TestimonialStatus = 'pending' | 'approved' | 'rejected';

export type TestimonialRow = {
  id: string;
  quote: string;
  name: string;
  role: string;
  status: TestimonialStatus;
  avatar_url: string | null;
  avatar_r2_key: string | null;
  avatar_content_type: string | null;
  created_at: string;
  updated_at: string;
};

export type FormDataEntryValue = string | File;

export type Env = {
  DB: D1Database;
  TESTIMONIAL_AVATARS: R2Bucket;
  TESTIMONIALS_ADMIN_TOKEN?: string;
};

// Kept for internal use by the existing handler functions below.
export type PagesContext = {
  request: Request;
  env: Env;
  params: {
    path?: string | string[];
  };
};

export type SubmissionPayload = {
  quote: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  avatarFile: File | null;
};

export type StoredAvatar = {
  key: string | null;
  contentType: string | null;
};

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const ALLOWED_AVATAR_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
export const SUBMISSION_WINDOW_MS = 60 * 60 * 1000;
export const SUBMISSION_LIMIT = 5;

// ─── Error ────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    readonly message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function createTestimonial({ request, env }: PagesContext) {
  const formData = await request.formData();
  const honeypot = String(formData.get('website') ?? '').trim();
  if (honeypot) return json({ ok: true }, 202);

  const payload = parseSubmission(formData);
  const ip = getClientIp(request);
  const rateLimit = await checkRateLimit(env.DB, ip);
  if (!rateLimit.allowed) {
    throw new ApiError('Too many submissions. Please try later.', 429);
  }

  const avatar = await storeAvatar(env.TESTIMONIAL_AVATARS, payload.avatarFile);
  const id = crypto.randomUUID();

  try {
    await insertTestimonial(env.DB, id, payload, avatar);
  } catch (error) {
    if (avatar.key) {
      await env.TESTIMONIAL_AVATARS.delete(avatar.key).catch(() => undefined);
    }

    throw error;
  }

  return json({ id, status: 'pending' }, 201);
}

export async function listApprovedTestimonials({ env }: PagesContext) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM testimonials
     WHERE status = 'approved'
     ORDER BY created_at DESC
     LIMIT 30`,
  ).all<TestimonialRow>();

  return json({
    testimonials: results.map(toPublicTestimonial),
  });
}

export async function listAdminTestimonials({ env }: PagesContext) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM testimonials
     ORDER BY created_at DESC
     LIMIT 100`,
  ).all<TestimonialRow>();

  return json({
    testimonials: results.map(toAdminTestimonial),
  });
}

export async function updateStatus(
  { env }: PagesContext,
  id: string,
  status: TestimonialStatus,
) {
  const result = await env.DB.prepare(
    `UPDATE testimonials
     SET status = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(status, new Date().toISOString(), id)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    throw new ApiError('Testimonial not found.', 404);
  }

  return json({ ok: true });
}

export async function deleteTestimonial({ env }: PagesContext, id: string) {
  const row = await env.DB.prepare(
    'SELECT avatar_r2_key FROM testimonials WHERE id = ?',
  )
    .bind(id)
    .first<{ avatar_r2_key: string | null }>();

  if (!row) {
    throw new ApiError('Testimonial not found.', 404);
  }

  const result = await env.DB.prepare('DELETE FROM testimonials WHERE id = ?')
    .bind(id)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    throw new ApiError('Testimonial not found.', 404);
  }

  if (row.avatar_r2_key) {
    await env.TESTIMONIAL_AVATARS.delete(row.avatar_r2_key).catch((error) => {
      console.error('Failed to delete testimonial avatar', {
        id,
        key: row.avatar_r2_key,
        error,
      });
    });
  }

  return json({ ok: true });
}

export async function serveAvatar({ env }: PagesContext, key: string) {
  const row = await env.DB.prepare(
    `SELECT id FROM testimonials
     WHERE avatar_r2_key = ? AND status = 'approved'`,
  )
    .bind(key)
    .first<{ id: string }>();

  if (!row) return json({ error: 'Avatar not found' }, 404);

  const object = await env.TESTIMONIAL_AVATARS.get(key);
  if (!object) return json({ error: 'Avatar not found' }, 404);

  return new Response(object.body, {
    headers: {
      'Cache-Control': 'no-cache, must-revalidate',
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function serveAdminAvatar({ env }: PagesContext, id: string) {
  const row = await env.DB.prepare(
    'SELECT avatar_r2_key FROM testimonials WHERE id = ?',
  )
    .bind(id)
    .first<{ avatar_r2_key: string | null }>();

  if (!row?.avatar_r2_key) return json({ error: 'Avatar not found' }, 404);

  const object = await env.TESTIMONIAL_AVATARS.get(row.avatar_r2_key);
  if (!object) return json({ error: 'Avatar not found' }, 404);

  return new Response(object.body, {
    headers: {
      'Cache-Control': 'private, max-age=300',
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    },
  });
}

export function toPublicTestimonial(row: TestimonialRow) {
  return {
    id: row.id,
    quote: row.quote,
    name: row.name,
    role: row.role,
    avatarUrl: row.avatar_r2_key
      ? `/api/testimonials/avatar/${encodeURIComponent(row.avatar_r2_key)}`
      : row.avatar_url ?? '',
  };
}

export function toAdminTestimonial(row: TestimonialRow) {
  return {
    ...toPublicTestimonial(row),
    status: row.status,
    avatarKind: row.avatar_r2_key ? 'r2' : row.avatar_url ? 'url' : 'none',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getModerationStatus(action: string) {
  if (action === 'approve') return 'approved';
  if (action === 'reject') return 'rejected';

  return null;
}

export function parseSubmission(formData: FormData): SubmissionPayload {
  const quote = normalizeRequiredField(formData.get('quote'), 20, 500, 'Quote');
  const name = normalizeRequiredField(formData.get('name'), 2, 80, 'Name');
  const role = normalizeRequiredField(formData.get('role'), 2, 120, 'Role');
  const avatarUrl = normalizeOptionalUrl(formData.get('avatarUrl'));
  const avatarFile = normalizeAvatarFile(formData.get('avatar'));

  if (!avatarFile && !avatarUrl) {
    throw new ApiError('Add an avatar upload or avatar URL.', 400);
  }

  return {
    quote,
    name,
    role,
    avatarUrl,
    avatarFile,
  };
}

export async function storeAvatar(
  bucket: R2Bucket,
  avatarFile: File | null,
): Promise<StoredAvatar> {
  if (!avatarFile) {
    return {
      key: null,
      contentType: null,
    };
  }

  const key = `testimonials/${crypto.randomUUID()}-${safeFileName(
    avatarFile.name,
  )}`;
  await bucket.put(key, await avatarFile.arrayBuffer(), {
    httpMetadata: { contentType: avatarFile.type },
  });

  return {
    key,
    contentType: avatarFile.type,
  };
}

export async function insertTestimonial(
  db: D1Database,
  id: string,
  payload: SubmissionPayload,
  avatar: StoredAvatar,
) {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO testimonials (
        id, quote, name, role, status, avatar_url, avatar_r2_key,
        avatar_content_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      payload.quote,
      payload.name,
      payload.role,
      payload.avatarUrl,
      avatar.key,
      avatar.contentType,
      now,
      now,
    )
    .run();
}

export async function checkRateLimit(db: D1Database, ip: string) {
  const windowStart = new Date(Date.now() - SUBMISSION_WINDOW_MS).toISOString();
  const ipHash = await sha256(ip);
  const now = new Date().toISOString();

  await db
    .prepare(
      `DELETE FROM testimonial_submission_rate_limits
       WHERE created_at < ?`,
    )
    .bind(windowStart)
    .run();

  const insertResult = await db
    .prepare(
      `INSERT INTO testimonial_submission_rate_limits (id, ip_hash, created_at)
       SELECT ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM testimonial_submission_rate_limits
         WHERE ip_hash = ? AND created_at > ?
       ) < ?`,
    )
    .bind(
      crypto.randomUUID(),
      ipHash,
      now,
      ipHash,
      windowStart,
      SUBMISSION_LIMIT,
    )
    .run();

  if ((insertResult.meta?.changes ?? 0) === 0) {
    return { allowed: false };
  }

  return { allowed: true };
}

export function requireAdmin(request: Request, env: Env) {
  const expectedToken = env.TESTIMONIALS_ADMIN_TOKEN;
  if (!expectedToken) return json({ error: 'Admin token is not configured.' }, 500);

  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token || token !== expectedToken) {
    return json({ error: 'Unauthorized' }, 401);
  }

  return null;
}

export function normalizeRequiredField(
  value: FormDataEntryValue | null,
  minLength: number,
  maxLength: number,
  label: string,
) {
  if (value !== null && typeof value !== 'string') {
    throw new ApiError(`${label} must be plain text.`, 400);
  }

  const text = (value ?? '').trim();
  if (text.length < minLength) {
    throw new ApiError(`${label} is too short.`, 400);
  }
  if (text.length > maxLength) {
    throw new ApiError(`${label} is too long.`, 400);
  }

  return text;
}

export function normalizeOptionalUrl(value: FormDataEntryValue | null) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiError('Avatar URL must be a valid URL.', 400);
  }

  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new ApiError('Avatar URL must use http or https.', 400);
  }

  return url.toString();
}

export function normalizeAvatarFile(value: FormDataEntryValue | null) {
  if (!(value instanceof File) || value.size === 0) return null;

  if (value.size > MAX_AVATAR_BYTES) {
    throw new ApiError('Avatar upload must be 2 MB or smaller.', 400);
  }

  if (!ALLOWED_AVATAR_TYPES.has(value.type)) {
    throw new ApiError('Avatar must be PNG, JPG, GIF, or WebP.', 400);
  }

  return value;
}

export function safeFileName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(0, 80);
}

export async function sha256(value: string) {
  const input = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', input);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function getClientIp(request: Request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;

  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  return 'unknown';
}

export function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
