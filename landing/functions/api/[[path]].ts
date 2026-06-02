import { Hono, type Context } from 'hono'
import { handle } from 'hono/cloudflare-pages'

// ─── Types ────────────────────────────────────────────────────────────────────

type TestimonialStatus = 'pending' | 'approved' | 'rejected';

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

type D1PreparedStatement = {
  bind: (...values: unknown[]) => D1PreparedStatement;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
  run: () => Promise<{ meta?: { changes?: number } }>;
};

type D1DatabaseBinding = {
  prepare: (query: string) => D1PreparedStatement;
};

type R2ObjectBody = {
  body: ReadableStream;
  httpMetadata?: {
    contentType?: string;
  };
};

type R2BucketBinding = {
  put: (
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<unknown>;
  get: (key: string) => Promise<R2ObjectBody | null>;
  delete: (key: string) => Promise<void>;
};

type Env = {
  DB: D1DatabaseBinding;
  TESTIMONIAL_AVATARS: R2BucketBinding;
  TESTIMONIALS_ADMIN_TOKEN?: string;
};

// Kept for internal use by the existing handler functions below.
type PagesContext = {
  request: Request;
  env: Env;
  params: {
    path?: string | string[];
  };
};

type SubmissionPayload = {
  quote: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  avatarFile: File | null;
};

type StoredAvatar = {
  key: string | null;
  contentType: string | null;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const SUBMISSION_WINDOW_MS = 60 * 60 * 1000;
const SUBMISSION_LIMIT = 5;

// ─── Error ────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── Hono app ─────────────────────────────────────────────────────────────────

type HonoEnv = { Bindings: Env }

// Adapts a Hono context into the shape the existing handler functions expect,
// so they can be used below without any modification.
function ctx(c: Context<HonoEnv>): PagesContext {
  return { request: c.req.raw, env: c.env, params: {} }
}

const app = new Hono<HonoEnv>().basePath('/api')

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return json({ error: err.message }, err.status)
  }
  console.error(err)
  return json({ error: 'Unexpected server error' }, 500)
})

app.notFound((c) =>
  json({ error: `No API route for ${c.req.path}` }, 404))

// Public routes
app.get('/testimonials', (c) =>
  listApprovedTestimonials(ctx(c)))

// The R2 key contains a slash (e.g. "testimonials/uuid-filename"), so the URL
// encodes it with encodeURIComponent. A wildcard route captures the full
// encoded key; we decode it back before passing to the handler.
app.get('/testimonials/avatar/*', (c) =>
  serveAvatar(ctx(c), decodeURIComponent(c.req.param('*'))))

app.post('/testimonials', (c) =>
  createTestimonial(ctx(c)))

// Admin – auth middleware applied to all /admin/* routes
app.use('/admin/*', async (c, next) => {
  const res = requireAdmin(c.req.raw, c.env)
  if (res) return res
  await next()
})

app.get('/admin/testimonials', (c) =>
  listAdminTestimonials(ctx(c)))

app.get('/admin/testimonials/:id/avatar', (c) =>
  serveAdminAvatar(ctx(c), c.req.param('id')))

app.post('/admin/testimonials/:id/approve', (c) =>
  updateStatus(ctx(c), c.req.param('id'), 'approved'))

app.post('/admin/testimonials/:id/reject', (c) =>
  updateStatus(ctx(c), c.req.param('id'), 'rejected'))

app.delete('/admin/testimonials/:id/delete', (c) =>
  deleteTestimonial(ctx(c), c.req.param('id')))

export const onRequest = handle(app)

// ─── Handlers ────────────────────────────────────────────────────────────────
// Everything below this line is unchanged from the original implementation.

async function createTestimonial({ request, env }: PagesContext) {
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

async function listApprovedTestimonials({ env }: PagesContext) {
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

async function listAdminTestimonials({ env }: PagesContext) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM testimonials
     ORDER BY created_at DESC
     LIMIT 100`,
  ).all<TestimonialRow>();

  return json({
    testimonials: results.map(toAdminTestimonial),
  });
}

async function updateStatus(
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

async function deleteTestimonial({ env }: PagesContext, id: string) {
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

  if (row?.avatar_r2_key) {
    await env.TESTIMONIAL_AVATARS.delete(row.avatar_r2_key);
  }

  return json({ ok: true });
}

async function serveAvatar({ env }: PagesContext, key: string) {
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

async function serveAdminAvatar({ env }: PagesContext, id: string) {
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

async function storeAvatar(
  bucket: R2BucketBinding,
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

async function insertTestimonial(
  db: D1DatabaseBinding,
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

async function checkRateLimit(db: D1DatabaseBinding, ip: string) {
  const windowStart = new Date(Date.now() - SUBMISSION_WINDOW_MS).toISOString();
  const ipHash = await sha256(ip);
  const row = await db.prepare(
    `SELECT COUNT(*) as count
     FROM testimonial_submission_rate_limits
     WHERE ip_hash = ? AND created_at > ?`,
  )
    .bind(ipHash, windowStart)
    .first<{ count: number }>();

  if ((row?.count ?? 0) >= SUBMISSION_LIMIT) {
    await db.prepare(
      `DELETE FROM testimonial_submission_rate_limits
       WHERE created_at < ?`,
    )
      .bind(windowStart)
      .run();

    return { allowed: false };
  }

  await db.prepare(
    `INSERT INTO testimonial_submission_rate_limits (id, ip_hash, created_at)
     VALUES (?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), ipHash, new Date().toISOString())
    .run();

  await db.prepare(
    `DELETE FROM testimonial_submission_rate_limits
     WHERE created_at < ?`,
  )
    .bind(windowStart)
    .run();

  return { allowed: true };
}

function requireAdmin(request: Request, env: Env) {
  const expectedToken = env.TESTIMONIALS_ADMIN_TOKEN;
  if (!expectedToken) return json({ error: 'Admin token is not configured.' }, 500);

  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token || token !== expectedToken) {
    return json({ error: 'Unauthorized' }, 401);
  }

  return null;
}

function normalizeRequiredField(
  value: FormDataEntryValue | null,
  minLength: number,
  maxLength: number,
  label: string,
) {
  const text = String(value ?? '').trim();
  if (text.length < minLength) {
    throw new ApiError(`${label} is too short.`, 400);
  }
  if (text.length > maxLength) {
    throw new ApiError(`${label} is too long.`, 400);
  }

  return text;
}

function normalizeOptionalUrl(value: FormDataEntryValue | null) {
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

function normalizeAvatarFile(value: FormDataEntryValue | null) {
  if (!(value instanceof File) || value.size === 0) return null;

  if (value.size > MAX_AVATAR_BYTES) {
    throw new ApiError('Avatar upload must be 2 MB or smaller.', 400);
  }

  if (!ALLOWED_AVATAR_TYPES.has(value.type)) {
    throw new ApiError('Avatar must be PNG, JPG, GIF, or WebP.', 400);
  }

  return value;
}

function safeFileName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(0, 80);
}

async function sha256(value: string) {
  const input = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', input);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function getClientIp(request: Request) {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For') ??
    'unknown'
  );
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}