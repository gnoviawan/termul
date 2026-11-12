# Troupe Documentation

Public documentation site for [Troupe](https://github.com/gnoviawan/troupe), built with Fumadocs, React Router, and static hosting.

## Development

From the repository root:

```bash
bun install --cwd website-docs
bun run docs:dev
```

## Validation

```bash
bun run docs:lint
bun run docs:typecheck
bun run docs:build
```

## Content

Write public documentation in `content/docs/`. Each `.mdx` file becomes a page under `/docs`, and the whole site, including search and the `llms.txt` files, is served under `/docs/`. Link to other pages with their full path, such as `/docs/agents`. Each section folder has a `meta.json` that orders its pages, and `content/docs/meta.json` orders the sections.

## Screenshots

Screenshots in `public/screenshots/` come from a script, so you can re-take them all after a UI change:

```bash
bun install                 # at the repo root: Playwright comes from there
bun run build:web
cargo build --release --bin troupe-server --features standalone-server
cd website-docs
bun scripts/screenshots/capture.ts            # every shot
bun scripts/screenshots/capture.ts git-       # only shots whose id contains "git-"
```

The script starts a throwaway `troupe-server` with demo projects under `/home/demo/projects` and a scripted demo agent, then drives the browser version of Troupe with Playwright. Each file in `scripts/screenshots/shots/` is one section. It gets a fresh server, so sections never see each other's chats or terminals. Set `TERMUL_SERVER_BIN` to use a server binary from somewhere else, and `DEMO_PORT` or `DEMO_WORKSPACE` to run two captures side by side.

Desktop-only features (embedded browser, SSH sessions, updates, sharing the desktop app) do not exist in the browser version, so their pages have no screenshots.

## Deploy

The site is planned for `https://docs.termul.dev`, which is not live yet. Cloudflare Pages must be configured with the `termul-docs` project and `website-docs/build/client` as its build output directory.

`bun run build` leaves the whole site in `build/client/docs/`. Its `404.html` is the SPA fallback, which Cloudflare Pages serves for unknown `/docs/*` URLs. `build/client/_redirects` sends the old root URLs (`/`, `/llms.txt`, `/llms-full.txt`, `/llms.mdx/docs/*`, `/api-reference.html`) to their `/docs/` paths, and only the standalone `termul-docs` project uses it.

The landing deploy (`.github/workflows/deploy-landing.yml`) also builds the docs and copies `build/client/docs/` to `landing/dist/docs/`, so one Pages project serves the landing page at `/` and the docs at `/docs/`.
