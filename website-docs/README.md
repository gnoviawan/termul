# Termul Documentation

Public documentation site for [Termul Manager](https://github.com/gnoviawan/termul), built with Fumadocs, React Router, and static hosting.

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

Write public documentation in `content/docs/`. Each `.mdx` file becomes a page under `/docs`.

The app deploys to `https://docs.termul.dev`. Cloudflare Pages must be configured with the `termul-docs` project and `website-docs/build/client` as its build output directory.
