import { Hono, type Context } from 'hono';
import { handle } from 'hono/cloudflare-pages';

import {
  ApiError,
  json,
  listApprovedTestimonials,
  serveAvatar,
  createTestimonial,
  requireAdmin,
  listAdminTestimonials,
  serveAdminAvatar,
  updateStatus,
  deleteTestimonial,
  type Env,
  type PagesContext,
} from './_lib';

// Re-export helpers and types used by tests or other modules
export {
  getClientIp,
  getModerationStatus,
  parseSubmission,
  toAdminTestimonial,
  toPublicTestimonial,
  type TestimonialRow,
} from './_lib';

type HonoEnv = { Bindings: Env };

// Adapts a Hono context into the shape the existing handler functions expect,
// so they can be used below without any modification.
function ctx(c: Context<HonoEnv>): PagesContext {
  return { request: c.req.raw, env: c.env, params: {} };
}

const app = new Hono<HonoEnv>().basePath('/api');

app.onError((err) => {
  if (err instanceof ApiError) {
    return json({ error: err.message }, err.status);
  }
  console.error(err);
  return json({ error: 'Unexpected server error' }, 500);
});

app.notFound((c) =>
  json({ error: `No API route for ${c.req.path}` }, 404));

// Public routes
app.get('/testimonials', (c) =>
  listApprovedTestimonials(ctx(c)));

// The R2 key contains a slash (e.g. "testimonials/uuid-filename"), so the URL
// encodes it with encodeURIComponent. A wildcard route captures the full
// encoded key; we decode it back before passing to the handler.
app.get('/testimonials/avatar/:key{.*}', (c) =>
  serveAvatar(ctx(c), decodeURIComponent(c.req.param('key') ?? '')));

app.post('/testimonials', (c) =>
  createTestimonial(ctx(c)));

// Admin – auth middleware applied to all /admin/* routes
app.use('/admin/*', async (c, next) => {
  const res = requireAdmin(c.req.raw, c.env);
  if (res) return res;
  await next();
});

app.get('/admin/testimonials', (c) =>
  listAdminTestimonials(ctx(c)));

app.get('/admin/testimonials/:id/avatar', (c) =>
  serveAdminAvatar(ctx(c), c.req.param('id')));

app.post('/admin/testimonials/:id/approve', (c) =>
  updateStatus(ctx(c), c.req.param('id'), 'approved'));

app.post('/admin/testimonials/:id/reject', (c) =>
  updateStatus(ctx(c), c.req.param('id'), 'rejected'));

app.delete('/admin/testimonials/:id/delete', (c) =>
  deleteTestimonial(ctx(c), c.req.param('id')));

export const onRequest = handle(app);