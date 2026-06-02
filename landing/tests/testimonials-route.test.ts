import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

// Mirrors production route pattern in functions/api/[[path]].ts
const app = new Hono().basePath('/api');
app.get('/testimonials/avatar/:key{.*}', (c) =>
  c.json({ key: decodeURIComponent(c.req.param('key') ?? '') }),
);

describe('testimonial avatar route', () => {
  test('captures encoded R2 keys that contain slashes', async () => {
    const r2Key = 'testimonials/uuid-file.png';
    const response = await app.request(
      `/api/testimonials/avatar/${encodeURIComponent(r2Key)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key: r2Key });
  });
});
