# Termul Landing Page

A standalone Vite + React marketing page for Termul Manager.

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

## Verify SEO Output

After `bun run build`:

1. Open `dist/index.html` and confirm `#app` contains rendered markup (e.g. "Terminal, reimagined", feature titles, footer CTA).
2. Run `bun run verify:prerender` for an automated check.
3. After deploy to `https://termul.dev`, validate with [Google Rich Results Test](https://search.google.com/test/rich-results) or view-source in the browser.
