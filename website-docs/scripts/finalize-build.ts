#!/usr/bin/env bun

/**
 * Post-build layout for the `/docs/` base path.
 *
 * React Router writes prerendered pages under build/client/docs/, but Vite
 * writes assets and public files to build/client/ while linking them as
 * /docs/... This script moves everything into build/client/docs/, so that
 * directory is the whole site as served under /docs/. The landing deploy
 * copies it to dist/docs/.
 *
 * The SPA fallback becomes docs/404.html: Cloudflare Pages serves the nearest
 * 404.html with a 404 status for unknown URLs, so /docs/* misses render the
 * docs not-found page and paths outside /docs are left to whoever owns them.
 *
 * build/client/_redirects is only read by the standalone docs project
 * (docs.termul.dev), which serves build/client at its root.
 */

import { existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { docsRoute } from '../app/lib/shared'

const client = 'build/client'
const site = join(client, docsRoute)
const spaFallback = join(client, 'index.html')

if (!existsSync(join(site, 'index.html')) || !existsSync(spaFallback)) {
  console.error(`Expected ${site}/index.html and the SPA fallback at ${spaFallback}.`)
  process.exit(1)
}

renameSync(spaFallback, join(site, '404.html'))

for (const entry of readdirSync(client)) {
  if (entry === docsRoute.slice(1)) continue
  const target = join(site, entry)
  if (existsSync(target)) {
    console.error(`${target} already exists; ${join(client, entry)} would overwrite it.`)
    process.exit(1)
  }
  renameSync(join(client, entry), target)
}

// Old root URLs from before the docs moved under /docs.
const redirects = [
  `/ ${docsRoute}/ 301`,
  `/llms.txt ${docsRoute}/llms.txt 301`,
  `/llms-full.txt ${docsRoute}/llms-full.txt 301`,
  `/llms.mdx/docs/* ${docsRoute}/llms.mdx/:splat 301`,
  `/api-reference.html ${docsRoute}/api-reference.html 301`
]
writeFileSync(join(client, '_redirects'), `${redirects.join('\n')}\n`)

console.log(`✓ ${site} holds the site; ${client}/_redirects written`)
