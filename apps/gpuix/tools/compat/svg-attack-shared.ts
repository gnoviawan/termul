import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ReactElement } from 'react'
import { jsx } from 'react/jsx-runtime'

export const TILE = 32
export const GRID_WIDTH = 1200
export const GRID_HEIGHT = 760
export const ICON_DIR = path.resolve(import.meta.dir, '../../../../src/renderer/assets/agent-icons')

export interface BundledIcon {
  name: string
  svg: string
  /** What G16's stand-in passed for it: the markup from `<svg` on, root size stripped. */
  legacyHtml: string
}

export function bundledIcons(): BundledIcon[] {
  return [...new Bun.Glob('**/*.svg').scanSync(ICON_DIR)].sort().map((name) => {
    const svg = readFileSync(path.join(ICON_DIR, name), 'utf8')
    const from = svg.slice(svg.indexOf('<svg')).trim()
    const legacyHtml = from.replace(/<svg\b[^>]*>/i, (tag) =>
      tag.replace(/\s+width="[^"]*"/g, '').replace(/\s+height="[^"]*"/g, '')
    )
    return { name, svg, legacyHtml }
  })
}

/** G16's monochrome `<svg source>` for an icon, sized to a tile: the before picture. */
export function legacyInnerHtmlSvg(html: string): ReactElement {
  const markup = html.trim()
  const namespaced = /^<svg[^>]*\sxmlns=/.test(markup)
    ? markup
    : markup.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"')
  return jsx('svg', {
    source: namespaced.replace(/currentColor/g, '#000'),
    style: { width: TILE, height: TILE, color: '#ffffff' }
  })
}
