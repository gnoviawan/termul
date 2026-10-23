/**
 * Chromium side of the showcase: the swatches as plain DOM with the CSS
 * Tailwind compiles from src/renderer/index.css, theme variables from the
 * same resolveThemeTokens the app writes to <html>.
 *
 *   bun tools/style/showcase/web.ts <out.png> [themeId]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveThemeTokens } from '@/lib/themes/resolve-theme-tokens'
import { compileTailwind, REPO } from '../tailwind-css'
import { allClasses, cellRect, SWATCHES, type SwatchNode } from './swatches'

const PORT = Number(process.env.SHOWCASE_PORT ?? 8197)

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function nodeHtml(node: SwatchNode): string {
  if (node.tag === 'input')
    return `<input class="${escapeHtml(node.classes)}" value="${escapeHtml(node.text ?? '')}">`
  const inner =
    node.text !== undefined ? escapeHtml(node.text) : (node.children ?? []).map(nodeHtml).join('')
  return `<div class="${escapeHtml(node.classes)}">${inner}</div>`
}

export function pageHtml(themeId: string): string {
  const tokens = resolveThemeTokens(themeId)
  const vars = Object.entries(tokens.vars)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')
  const cells = SWATCHES.map((swatch, i) => {
    const r = cellRect(i)
    const box = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;display:flex;align-items:center;justify-content:center`
    const wrap = swatch.width
      ? `<div style="width:${swatch.width}px;display:flex">${nodeHtml(swatch.node)}</div>`
      : nodeHtml(swatch.node)
    return `<div data-swatch="${swatch.id}" class="${swatch.surface}" style="${box}">${wrap}</div>`
  }).join('\n')
  return `<!doctype html>
<html class="${tokens.appearance === 'dark' ? 'dark' : ''}" style="${vars}; color-scheme: ${tokens.appearance}"${tokens.flatElevation ? ' data-flat-elevation="true"' : ''}>
<head><meta charset="utf-8">
<link rel="stylesheet" href="/inter/index.css">
<link rel="stylesheet" href="/index.css">
<style>html,body{margin:0;width:1280px;height:800px;overflow:hidden}</style>
</head>
<body class="bg-background text-foreground font-sans antialiased" style="position:relative">
${cells}
</body></html>`
}

export async function serveShowcase(themeId: string) {
  const css = await compileTailwind(allClasses())
  const interDir = join(REPO, 'node_modules/@fontsource-variable/inter')
  return Bun.serve({
    port: PORT,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname)
      if (path === '/')
        return new Response(pageHtml(themeId), { headers: { 'content-type': 'text/html' } })
      if (path === '/index.css')
        return new Response(css, { headers: { 'content-type': 'text/css' } })
      const file = path.startsWith('/inter/')
        ? join(interDir, path.slice('/inter/'.length))
        : path.startsWith('/assets/')
          ? join(REPO, 'src/renderer', path)
          : undefined
      if (file && existsSync(file)) return new Response(Bun.file(file))
      return new Response('not found', { status: 404 })
    }
  })
}

export async function screenshotWeb(out: string, themeId: string): Promise<void> {
  const server = await serveShowcase(themeId)
  const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1
    })
    await page.goto(`http://127.0.0.1:${PORT}/`)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: out })
  } finally {
    await browser.close()
    server.stop(true)
  }
}

if (import.meta.main) {
  const [out = '/tmp/gpuix-s1/web.png', themeId = 'termul'] = process.argv.slice(2)
  await screenshotWeb(out, themeId)
  console.log(`wrote ${out} (${readFileSync(out).length} bytes)`)
}
