# Termul Landing Page

A standalone Vite + React marketing page for Termul Manager, hosted on Cloudflare Pages.

## Prerequisites

- [Bun](https://bun.sh) 1.3+ (pinned in `package.json` as `bun@1.3.11`)

Run commands from this `landing/` directory, or from the repo root via `bun run landing:dev`, `landing:build`, and `landing:lint`.

## Development

```bash
bun install
bun run dev
```

The dev server runs from this `landing/` directory and does not affect the Tauri desktop app. Dev mode is a standard SPA with HMR; prerendering only runs on production build.

## Production Build

```bash
bun run build
bun run verify:prerender
bun run preview
```

The build uses `vite-plugin-react-ssg` to prerender `/` into static HTML at build time. Crawlers receive full page content in `dist/index.html` while the client bundle hydrates for interactivity.

Static SEO files ship from `public/`:

- `robots.txt`
- `sitemap.xml`
- `og-image.png`

## Deploy to Cloudflare Pages

Deploy the static build to Cloudflare Pages via the `wrangler` CLI:

```bash
bun run build
bun run deploy
```

The `deploy` script invokes `wrangler pages deploy dist` and uploads the build output to the `termul-landing` project.

**First-time setup:**

1. Run `bunx wrangler login` to authenticate with your Cloudflare account.
2. Create the Pages project (already done — `termul-landing`):
   ```bash
   bunx wrangler pages project create termul-landing --production-branch main
   ```
3. Connect the custom domain `termul.dev`:
   - Go to [Cloudflare Pages → termul-landing → Custom domains](https://dash.cloudflare.com/?to=/:account/pages/view/termul-landing/custom-domains)
   - Click **Set up a custom domain** and enter `termul.dev`
   - Cloudflare auto-provisions SSL and routes traffic (DNS must be on Cloudflare)

**SPA routing:** The `public/_redirects` file rewrites all paths to `/index.html` with a 200 status, replacing the nginx `try_files` rule used in the previous Docker setup.

## Testimonials Backend (D1 + R2)

The `/testimonial/submit` form, the `/testimonial/list` admin dashboard, and the
homepage testimonials marquee are served by a Cloudflare Pages Function
(`functions/api/[[path]].ts`) backed by a D1 database and an R2 bucket. Bindings
are declared in `wrangler.toml`:

- `DB` — D1 database `termul` (table schema in `migrations/0001_testimonials.sql`)
- `TESTIMONIAL_AVATARS` — R2 bucket `termul` for uploaded avatar images
- `TESTIMONIALS_ADMIN_TOKEN` — bearer token guarding the `/api/admin/*` routes

### Local development

Local dev runs D1 and R2 in a simulated environment — no Cloudflare account
access is needed.

1. Create a local admin token in `.dev.vars` (gitignored):
   ```bash
   echo "TESTIMONIALS_ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")" > .dev.vars
   ```
2. Apply migrations to the local database:
   ```bash
   bun run db:migrate:local
   ```
3. Build and start the Pages dev server (reads bindings from `wrangler.toml`):
   ```bash
   bun run pages:dev
   ```
   The API is then available at `http://127.0.0.1:8788/api/testimonials`.

> Run `wrangler pages dev` without manual `--d1`/`--r2` flags so it uses the
> same local database that `db:migrate:local` wrote to. Passing those flags
> creates a separate, unmigrated instance.

Quick smoke test:

```bash
BASE=http://127.0.0.1:8788
TOKEN=$(grep TESTIMONIALS_ADMIN_TOKEN .dev.vars | cut -d= -f2)

# submit (pending)
curl -X POST $BASE/api/testimonials \
  -F "quote=Termul keeps every project terminal in one workspace." \
  -F "name=Alex Chen" -F "role=Staff Engineer" -F "avatarUrl=https://example.com/a.png"

# moderate (use the id returned above)
curl -H "Authorization: Bearer $TOKEN" $BASE/api/admin/testimonials
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/api/admin/testimonials/<id>/approve

# public list now includes the approved entry
curl $BASE/api/testimonials
```

### Production setup (one-time)

These resources already exist for `termul-landing`; recreate only when
provisioning a fresh environment.

1. Authenticate: `bunx wrangler login`.
2. Create the D1 database and copy its `database_id` into `wrangler.toml`:
   ```bash
   bunx wrangler d1 create termul
   ```
3. Create the R2 bucket:
   ```bash
   bunx wrangler r2 bucket create termul
   ```
4. Apply migrations to the remote database:
   ```bash
   bun run db:migrate
   ```
5. Set the admin token as a Pages secret (do **not** commit it):
   ```bash
   bunx wrangler pages secret put TESTIMONIALS_ADMIN_TOKEN --project-name termul-landing
   ```

The CI deploy workflow (`.github/workflows/deploy-landing.yml`) handles building
and uploading; it does not run migrations, so apply schema changes manually with
`bun run db:migrate` before deploying code that depends on them.

## Verify SEO Output

After `bun run build`:

1. Open `dist/index.html` and confirm `#app` contains rendered markup (e.g. "Terminal, reimagined", feature titles, footer CTA).
2. Run `bun run verify:prerender` for an automated check.
3. After deploy to `https://termul.dev`, validate with [Google Rich Results Test](https://search.google.com/test/rich-results) or view-source in the browser.
