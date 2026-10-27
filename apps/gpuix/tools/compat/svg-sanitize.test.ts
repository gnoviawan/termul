import { describe, expect, test } from 'bun:test'
import { isValidElement } from 'react'
import DOMPurify from '../../src/compat/shims/dompurify'
import { innerHtmlSvg } from '../../src/compat/svg'
import { SVG_ATTACKS } from './svg-attacks'
import { bundledIcons } from './svg-attack-shared'

const SVG = { USE_PROFILES: { svg: true } }
const ALLOWED = new Set([
  'svg', 'g', 'defs', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'clipPath',
  'mask', 'linearGradient', 'radialGradient', 'stop', 'text', 'title', 'desc'
])
const BUDGET_MS = 50

function sanitize(markup: string): { out: string; ms: number } {
  const start = performance.now()
  const out = DOMPurify.sanitize(markup, SVG)
  return { out, ms: performance.now() - start }
}

/** What a renderer could act on in sanitized output, besides shapes and their geometry. */
function hazards(out: string): string[] {
  const found: string[] = []
  for (const [, name] of out.matchAll(/<\/?([^\s/>]+)/g)) if (!ALLOWED.has(name as string)) found.push(`<${name}>`)
  for (const [, name, value] of out.matchAll(/\s([^\s=<>]+)="([^"]*)"/g)) {
    if (/^on|^style$|^class$|:/i.test(name as string)) found.push(name as string)
    if (name === 'href' && !/^#[\w.-]+$/.test(value as string)) found.push(`href=${value}`)
  }
  if (/url\(\s*(?!#)/i.test(out)) found.push('non-fragment url()')
  let depth = 0
  let deepest = 0
  for (const [tag] of out.matchAll(/<\/?[^>]+>/g)) {
    if (tag.startsWith('</')) depth--
    else if (!tag.endsWith('/>')) deepest = Math.max(deepest, ++depth)
    else deepest = Math.max(deepest, depth + 1)
  }
  if (deepest > 64) found.push(`depth ${deepest}`)
  return found
}

describe('the dompurify stand-in on hostile SVG', () => {
  for (const attack of SVG_ATTACKS) {
    test(`${attack.id}: ${attack.expect === 'reject' ? 'rejected' : 'reduced to inert shapes'} in under ${BUDGET_MS} ms`, () => {
      sanitize(attack.markup)
      const { out, ms } = sanitize(`${attack.markup} `)
      expect(ms).toBeLessThan(BUDGET_MS)
      if (attack.expect === 'reject') {
        expect(out).toBe('')
        return
      }
      expect(out).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"')
      expect(hazards(out)).toEqual([])
      expect(DOMPurify.sanitize(out, SVG)).toBe(out)
    })
  }

  test('strips script, event attributes, remote links and drawing primitives it does not allow', () => {
    expect(DOMPurify.sanitize('<svg viewBox="0 0 1 1"><script>x()</script></svg>', SVG)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'
    )
    expect(DOMPurify.sanitize('<svg viewBox="0 0 1 1" onload="x()"><path d="M0 0"/></svg>', SVG)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0"/></svg>'
    )
    expect(
      DOMPurify.sanitize(
        '<svg viewBox="0 0 1 1"><image href="/etc/x.png"/><filter id="f"><feTurbulence numOctaves="100000"/></filter><rect width="1" height="1" filter="url(#f)" fill="url(https://evil.test/#g)"/></svg>',
        SVG
      )
    ).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')
  })

  test('keeps fragment references between gradients, clips and masks', () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><defs><linearGradient id="g" xlink:href="#h"/><clipPath id="c"><rect width="1" height="1" mask="url(#m)"/></clipPath></defs><rect width="2" height="2" fill="url(#g)" clip-path="url(#c)"/></svg>'
    expect(DOMPurify.sanitize(markup, SVG)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><defs><linearGradient id="g" href="#h"/><clipPath id="c"><rect width="1" height="1"/></clipPath></defs><rect width="2" height="2" fill="url(#g)" clip-path="url(#c)"/></svg>'
    )
  })

  test('fails closed on any profile but svg', () => {
    expect(DOMPurify.sanitize('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>')).toBe('')
  })
})

describe('bundled agent icons through the stand-in', () => {
  const icons = bundledIcons()

  test('every icon keeps every shape and its text', () => {
    expect(icons.length).toBe(55)
    for (const icon of icons) {
      const out = DOMPurify.sanitize(icon.svg, SVG)
      const shapes = (markup: string) => markup.match(/<(?:path|circle|ellipse|rect|line|polyline|polygon|g|text|title)\b/g)?.length ?? 0
      expect({ icon: icon.name, shapes: shapes(out), text: out.match(/<text[^>]*>([^<]*)/)?.[1] ?? null }).toEqual({
        icon: icon.name,
        shapes: shapes(icon.svg),
        text: icon.svg.match(/<text[^>]*>([^<]*)/)?.[1] ?? null
      })
      expect(hazards(out)).toEqual([])
    }
  })
})

describe('innerHtmlSvg', () => {
  test('re-checks markup no sanitizer saw', () => {
    expect(innerHtmlSvg(`<svg viewBox="0 0 1 1">${'<g>'.repeat(3500)}<path d="M0 0h1v1z"/>${'</g>'.repeat(3500)}</svg>`)).toBeNull()
    const element = innerHtmlSvg('<svg viewBox="0 0 1 1"><image href="/dev/zero"/><path onclick="x()" d="M0 0h1v1z"/></svg>')
    expect(isValidElement(element)).toBe(true)
    expect((element?.props as { native: { source: string } }).native.source).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>'
    )
  })

  test('rasterises a full-colour icon at its box, not its viewBox or declared size', () => {
    const src = (html: string) => decodeURIComponent((innerHtmlSvg(html)?.props as { src: string }).src.split(',')[1] as string)
    expect(src('<svg viewBox="0 0 100000 100000"><rect width="100000" height="100000" fill="#f00"/></svg>')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 100000" width="16" height="16"><rect width="100000" height="100000" fill="#f00"/></svg>'
    )
    const huge = innerHtmlSvg('<svg viewBox="0 0 24 24" width="100000" height="50000"><rect width="24" height="24" fill="#0f0"/></svg>')
    expect((huge?.props as { style: unknown }).style).toEqual({ width: 100000, height: 50000 })
    expect(decodeURIComponent((huge?.props as { src: string }).src)).toContain('width="256" height="128"')
  })
})
