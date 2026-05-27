# Termul Landing Page

A standalone Vite + React marketing page for Termul Manager.

## Development

```bash
npm install
npm run dev
```

The dev server runs from this `landing/` directory and does not affect the Tauri desktop app. Dev mode is a standard SPA with HMR; prerendering only runs on production build.

## Production Build

```bash
npm run build
npm run verify:prerender
npm run preview
```

The build uses `vite-plugin-react-ssg` to prerender `/` into static HTML at build time. Crawlers receive full page content in `dist/index.html` while the client bundle hydrates for interactivity.

Static SEO files ship from `public/`:

- `robots.txt`
- `sitemap.xml`
- `og-image.png`

## Verify SEO Output

After `npm run build`:

1. Open `dist/index.html` and confirm `#app` contains rendered markup (e.g. "Terminal, reimagined", feature titles, footer CTA).
2. Run `npm run verify:prerender` for an automated check.
3. After deploy to `https://termul.dev`, validate with [Google Rich Results Test](https://search.google.com/test/rich-results) or view-source in the browser.
