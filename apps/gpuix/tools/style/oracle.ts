/**
 * Checks tw() against the browser. Every distinct utility the renderer uses
 * (variants stripped) that tw() claims to support is applied to a <div> in
 * Chromium with the CSS Tailwind compiles from index.css; each StyleDesc key
 * tw() emits is compared with getComputedStyle.
 *
 *   bun tools/style/oracle.ts [themeId] [--list]
 */
import { join } from 'node:path'
import type { StyleDesc } from '@gpuix/react'
import { formatColor, parseColor } from '../../src/style/css-value'
import { resolveTwTheme } from '../../src/style/theme'
import { createTw } from '../../src/style/tw'
import { scanRenderer } from './scan-classes'
import { pageHtml } from './showcase/web'
import { compileTailwind, REPO } from './tailwind-css'

const themeId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'termul'
const tw = createTw(resolveTwTheme(themeId))
const PARENT = { width: 400, height: 300 }

/** StyleDesc key -> CSS property read back from getComputedStyle. */
const CSS_PROPERTY: Partial<Record<keyof StyleDesc, string>> = {
  display: 'display',
  flexDirection: 'flex-direction',
  flexWrap: 'flex-wrap',
  flexGrow: 'flex-grow',
  flexShrink: 'flex-shrink',
  alignItems: 'align-items',
  alignSelf: 'align-self',
  justifyContent: 'justify-content',
  gap: 'row-gap',
  rowGap: 'row-gap',
  columnGap: 'column-gap',
  width: 'width',
  height: 'height',
  minWidth: 'min-width',
  minHeight: 'min-height',
  maxWidth: 'max-width',
  maxHeight: 'max-height',
  paddingTop: 'padding-top',
  paddingRight: 'padding-right',
  paddingBottom: 'padding-bottom',
  paddingLeft: 'padding-left',
  marginTop: 'margin-top',
  marginRight: 'margin-right',
  marginBottom: 'margin-bottom',
  marginLeft: 'margin-left',
  position: 'position',
  top: 'top',
  right: 'right',
  bottom: 'bottom',
  left: 'left',
  backgroundColor: 'background-color',
  color: 'color',
  opacity: 'opacity',
  borderWidth: 'border-top-width',
  borderTopWidth: 'border-top-width',
  borderRightWidth: 'border-right-width',
  borderBottomWidth: 'border-bottom-width',
  borderLeftWidth: 'border-left-width',
  borderColor: 'border-top-color',
  borderRadius: 'border-top-left-radius',
  borderTopLeftRadius: 'border-top-left-radius',
  borderTopRightRadius: 'border-top-right-radius',
  borderBottomLeftRadius: 'border-bottom-left-radius',
  borderBottomRightRadius: 'border-bottom-right-radius',
  borderStyle: 'border-top-style',
  fontSize: 'font-size',
  fontWeight: 'font-weight',
  lineHeight: 'line-height',
  textAlign: 'text-align',
  whiteSpace: 'white-space',
  textOverflow: 'text-overflow',
  textDecoration: 'text-decoration-line',
  overflow: 'overflow-x',
  overflowX: 'overflow-x',
  overflowY: 'overflow-y',
  cursor: 'cursor',
  pointerEvents: 'pointer-events',
  userSelect: 'user-select',
  visibility: 'visibility',
  outlineWidth: 'outline-style',
  aspectRatio: 'aspect-ratio'
}

const COLOR_KEYS = new Set(['backgroundColor', 'color', 'borderColor'])
/** tw() spelling -> computed spelling, where GPUIX names differ from CSS. */
const ENUM_ALIASES: Record<string, string> = {
  start: 'flex-start',
  end: 'flex-end',
  scroll: 'auto',
  none: 'none'
}

function expectedText(key: string, value: unknown): string {
  if (COLOR_KEYS.has(key))
    return String(value).endsWith('00') && String(value).length === 9
      ? 'transparent'
      : String(value)
  if (key === 'outlineWidth') return value === 0 ? 'none' : 'solid'
  if (typeof value === 'number' && value >= 9999) return 'pill'
  if (typeof value === 'number') {
    if (key === 'opacity' || key === 'flexGrow' || key === 'flexShrink' || key === 'fontWeight')
      return String(value)
    if (key === 'aspectRatio') return String(value)
    return `${Math.round(value * 10) / 10}px`
  }
  if (typeof value === 'string' && value.endsWith('%')) {
    const fraction = Number.parseFloat(value) / 100
    const basis = key.toLowerCase().includes('height') ? PARENT.height : PARENT.width
    return `${Math.round(fraction * basis * 10) / 10}px`
  }
  return ENUM_ALIASES[String(value)] ?? String(value)
}

function actualText(key: string, computed: string): string {
  if (COLOR_KEYS.has(key)) {
    try {
      const hex = formatColor(parseColor(computed))
      return hex.length === 9 && hex.endsWith('00') ? 'transparent' : hex
    } catch {
      return computed
    }
  }
  if (key === 'aspectRatio') {
    const [a, b] = computed.split('/').map(Number)
    return String(b ? a / b : a)
  }
  if (/^[\d.e+]+px$/.test(computed) && Number.parseFloat(computed) >= 9999) return 'pill'
  if (/^-?[\d.]+px$/.test(computed)) return `${Math.round(Number.parseFloat(computed) * 10) / 10}px`
  if (/^[\d.]+%$/.test(computed)) {
    const basis = key.toLowerCase().includes('height') ? PARENT.height : PARENT.width
    return `${Math.round((Number.parseFloat(computed) / 100) * basis * 10) / 10}px`
  }
  if (key === 'textDecoration' && computed === 'none') return 'none'
  return computed
}

function stripVariants(token: string): string {
  let depth = 0
  let last = 0
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '[' || token[i] === '(') depth++
    else if (token[i] === ']' || token[i] === ')') depth--
    else if (token[i] === ':' && depth === 0) last = i + 1
  }
  return token.slice(last).replace(/^!|!$/g, '')
}

const { counts } = scanRenderer()
const utilities = new Map<string, number>()
for (const [token, count] of counts) {
  const utility = stripVariants(token)
  utilities.set(utility, (utilities.get(utility) ?? 0) + count)
}
const supported = [...utilities].filter(([u]) => tw.compile(u).issues.length === 0)
const approximate = [...utilities].filter(([u]) =>
  tw.compile(u).issues.some((i) => i.kind === 'approximate')
)

const css = await compileTailwind(supported.map(([u]) => u))
const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const html = pageHtml(themeId)
  .replace(/<link[^>]*index\.css">/, `<style>${css}</style>`)
  .replace(/<link[^>]*inter[^>]*>/, '')
await page.setContent(html)

const rows: { utility: string; count: number; mismatches: string[] }[] = []
for (const [utility, count] of supported) {
  const style = tw(utility) as Record<string, unknown>
  // `auto` sizes resolve to px in the browser; there is nothing to compare.
  const keys = Object.keys(style).filter((k) => k in CSS_PROPERTY && style[k] !== 'auto')
  if (keys.length === 0) continue
  const props = keys.map((k) => CSS_PROPERTY[k as keyof StyleDesc] as string)
  const computed: string[] = await page.evaluate(
    ({ utility, props, parent }: { utility: string; props: string[]; parent: typeof PARENT }) => {
      const host = document.createElement('div')
      host.style.cssText = `position:relative;width:${parent.width}px;height:${parent.height}px;font-size:16px;line-height:1.5;display:block`
      const el = document.createElement('div')
      el.className = utility
      host.append(el)
      document.body.append(host)
      const cs = getComputedStyle(el)
      const out = props.map((p) => cs.getPropertyValue(p))
      host.remove()
      return out
    },
    { utility, props, parent: PARENT }
  )
  const mismatches: string[] = []
  keys.forEach((key, i) => {
    const want = expectedText(key, style[key])
    const got = actualText(key, computed[i])
    if (want !== got) mismatches.push(`${key}: tw ${want} vs css ${got}`)
  })
  rows.push({ utility, count, mismatches })
}
await browser.close()

const agree = rows.filter((r) => r.mismatches.length === 0)
const weight = (list: typeof rows) => list.reduce((n, r) => n + r.count, 0)
console.log(
  `theme ${themeId}: ${agree.length}/${rows.length} utilities agree with Chromium ` +
    `(${((100 * agree.length) / rows.length).toFixed(1)}%), ` +
    `${weight(agree)}/${weight(rows)} occurrences (${((100 * weight(agree)) / weight(rows)).toFixed(1)}%)`
)
console.log(
  `(${approximate.length} approximate utilities, flagged by tw(), are not part of this check)`
)
const bad = rows.filter((r) => r.mismatches.length > 0).sort((a, b) => b.count - a.count)
for (const row of process.argv.includes('--list') ? bad : bad.slice(0, 40)) {
  console.log(`${String(row.count).padStart(5)}  ${row.utility}  ${row.mismatches.join('; ')}`)
}
