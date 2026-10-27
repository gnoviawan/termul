/**
 * Hostile SVG icons for the GPUIX svg path: the security review of G16's
 * dangerouslySetInnerHTML support (S2) and the classic sanitizer bypasses.
 * `reject` inputs must sanitize to nothing; `render` inputs must come out as
 * markup the native renderer paints in bounded time.
 */

export interface SvgAttack {
  id: string
  markup: string
  expect: 'reject' | 'render'
}

const NS = 'xmlns="http://www.w3.org/2000/svg"'
const svg = (body: string, attrs = 'viewBox="0 0 24 24"') => `<svg ${NS} ${attrs}>${body}</svg>`
const nest = (depth: number, leaf: string) => `${'<g>'.repeat(depth)}${leaf}${'</g>'.repeat(depth)}`
const repeat = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('')

/** Masks that each paint the next one twice: 2^n mask renders if nothing caches them. */
function maskFan(levels: number): string {
  let defs = ''
  for (let i = 0; i < levels; i++) {
    const next = i + 1 < levels ? ` mask="url(#m${i + 1})"` : ''
    defs += `<mask id="m${i}"><rect width="24" height="24" fill="#fff"${next}/><rect width="12" height="12" fill="#fff"${next}/></mask>`
  }
  return svg(`<defs>${defs}</defs><rect width="24" height="24" fill="#f00" mask="url(#m0)"/>`)
}

export const SVG_ATTACKS: SvgAttack[] = [
  {
    id: 'depth-bomb-img',
    markup: `<svg viewBox="0 0 1 1">${nest(3500, '<path fill="#000" d="M0 0h1v1z"/>')}</svg>`,
    expect: 'reject'
  },
  {
    id: 'depth-bomb-mono',
    markup: `<svg viewBox="0 0 1 1">${nest(9000, '<path d="M0 0h1v1z"/>')}</svg>`,
    expect: 'reject'
  },
  {
    id: 'depth-bomb-mono-oversize',
    markup: `<svg viewBox="0 0 1 1">${nest(14000, '<path d="M0 0h1v1z"/>')}</svg>`,
    expect: 'reject'
  },
  { id: 'depth-65', markup: svg(nest(63, '<path d="M0 0h1v1z"/>')), expect: 'reject' },
  { id: 'depth-64', markup: svg(nest(62, '<path d="M0 0h24v24z"/>')), expect: 'render' },
  {
    id: 'fe-turbulence',
    markup: svg(
      '<filter id="f"><feTurbulence baseFrequency="0.5" numOctaves="100000"/></filter><rect width="24" height="24" filter="url(#f)"/>'
    ),
    expect: 'render'
  },
  {
    id: 'fe-morphology',
    markup: svg(
      '<filter id="f"><feMorphology radius="2000"/></filter><rect width="24" height="24" fill="#f00" filter="url(#f)"/>'
    ),
    expect: 'render'
  },
  {
    id: 'fe-gaussian-blur',
    markup: svg(
      '<filter id="f" x="-1000" y="-1000" width="3000" height="3000"><feGaussianBlur stdDeviation="1000"/></filter><rect width="24" height="24" fill="#f00" filter="url(#f)"/>',
      'viewBox="0 0 24 24" width="8000" height="8000"'
    ),
    expect: 'render'
  },
  {
    id: 'huge-viewbox-colour',
    markup: svg('<rect width="100000" height="100000" fill="#f00"/>', 'viewBox="0 0 100000 100000"'),
    expect: 'render'
  },
  {
    id: 'huge-size-attrs-colour',
    markup: svg('<rect width="24" height="24" fill="#0f0"/>', 'viewBox="0 0 24 24" width="100000" height="100000"'),
    expect: 'render'
  },
  { id: 'image-dev-zero', markup: svg('<image href="/dev/zero" width="24" height="24"/>'), expect: 'render' },
  {
    id: 'image-xlink-fifo',
    markup: `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><image xlink:href="/tmp/gpuix-s2/fifo" width="24" height="24"/><path d="M0 0h24v24z"/></svg>`,
    expect: 'render'
  },
  { id: 'fe-image', markup: svg('<filter id="f"><feImage href="/dev/zero"/></filter><rect width="9" height="9" filter="url(#f)"/>'), expect: 'render' },
  { id: 'slash-onclick', markup: svg('<path d="M0 0h24v24z"/onclick="x()"/>'), expect: 'reject' },
  { id: 'glued-onclick', markup: svg('<path d="M0 0h24v24z"onclick="x()"/>'), expect: 'reject' },
  { id: 'onload-newline', markup: `<svg ${NS}\nonload="x()" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>`, expect: 'render' },
  { id: 'onload-uppercase', markup: svg('<path ONLOAD="x()" d="M0 0h24v24z"/>'), expect: 'render' },
  {
    id: 'prefixed-script',
    markup: `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><s:script>x()</s:script><path d="M0 0h24v24z"/></svg>`,
    expect: 'render'
  },
  {
    id: 'prefixed-onload',
    markup: `<svg ${NS} xmlns:e="http://www.w3.org/2000/svg" e:onload="x()" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>`,
    expect: 'render'
  },
  { id: 'script', markup: svg('<script>x()</script><path d="M0 0h24v24z"/>'), expect: 'render' },
  { id: 'script-uppercase', markup: svg('<SCRIPT>x()</SCRIPT><path d="M0 0h24v24z"/>'), expect: 'render' },
  { id: 'script-in-cdata', markup: svg('<![CDATA[<script>x()</script>]]><path d="M0 0h24v24z"/>'), expect: 'render' },
  { id: 'script-in-comment', markup: svg('<!--><script>x()</script>--><path d="M0 0h24v24z"/>'), expect: 'render' },
  {
    id: 'animate-href',
    markup: svg('<a><animate attributeName="href" values="javascript:x()"/><path d="M0 0h24v24z"/></a>'),
    expect: 'render'
  },
  { id: 'set-onmouseover', markup: svg('<set attributeName="onmouseover" to="x()"/><path d="M0 0h24v24z"/>'), expect: 'render' },
  { id: 'anchor-javascript', markup: svg('<a href="javascript:x()"><path d="M0 0h24v24z"/></a>'), expect: 'render' },
  {
    id: 'foreign-object',
    markup: svg('<foreignObject width="24" height="24"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
    expect: 'render'
  },
  { id: 'style-element', markup: svg('<style>path{fill:url(https://evil.test/x)}</style><path d="M0 0h24v24z"/>'), expect: 'render' },
  { id: 'style-attribute', markup: svg('<path style="fill:url(https://evil.test/x)" d="M0 0h24v24z"/>'), expect: 'render' },
  { id: 'external-paint', markup: svg('<path fill="url(https://evil.test/x#g)" d="M0 0h24v24z"/>'), expect: 'render' },
  {
    id: 'use-fan-out',
    markup: svg(
      `<defs><path id="a0" d="M0 0h1v1z"/>${repeat(12, (i) => `<g id="a${i + 1}"><use href="#a${i}"/><use href="#a${i}"/></g>`)}</defs><use href="#a12"/>`
    ),
    expect: 'render'
  },
  {
    id: 'billion-laughs',
    markup: `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>${svg('<title>&c;</title>')}`,
    expect: 'reject'
  },
  { id: 'undeclared-entity', markup: svg('<title>&nbsp;</title><path d="M0 0h24v24z"/>'), expect: 'reject' },
  { id: 'stylesheet-pi', markup: `<?xml-stylesheet href="https://evil.test/x.css"?>${svg('<path d="M0 0h24v24z"/>')}`, expect: 'reject' },
  { id: 'trailing-script', markup: `${svg('<path d="M0 0h24v24z"/>')}<script>x()</script>`, expect: 'reject' },
  { id: 'two-roots', markup: `${svg('<path d="M0 0h24v24z"/>')}${svg('<path d="M0 0h1v1z"/>')}`, expect: 'reject' },
  { id: 'html-root', markup: '<div><svg viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg></div>', expect: 'reject' },
  { id: 'xhtml-namespace-root', markup: '<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>', expect: 'reject' },
  { id: 'unclosed', markup: '<svg viewBox="0 0 24 24"><g><path d="M0 0h24v24z"/></svg>', expect: 'reject' },
  { id: 'unquoted-attribute', markup: '<svg viewBox=0><path d="M0 0h24v24z"/></svg>', expect: 'reject' },
  { id: 'nested-svg', markup: svg(`<svg ${NS} viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg><path d="M0 0h24v24z"/>`), expect: 'render' },
  {
    id: 'text-flood',
    markup: svg(`<text x="0" y="20" font-size="20">${'W'.repeat(60_000)}</text>`),
    expect: 'reject'
  },
  { id: 'opacity-layers', markup: svg(repeat(2500, () => '<g opacity=".5"><path d="M0 0h24v24z"/></g>')), expect: 'reject' },
  { id: 'opacity-layers-32', markup: svg(repeat(32, () => '<g opacity=".5"><path d="M0 0h24v24z"/></g>')), expect: 'render' },
  {
    id: 'mask-wide',
    markup: svg(
      `<defs><mask id="m">${repeat(990, () => '<path d="M0 0h24v24z" fill="#fff"/>')}</mask></defs>${repeat(31, () => '<rect width="24" height="24" fill="#f00" mask="url(#m)"/>')}`
    ),
    expect: 'render'
  },
  {
    id: 'gradient-href-cycle',
    markup: svg(
      '<defs><linearGradient id="a" href="#b"><stop offset="0" stop-color="#f00"/></linearGradient><linearGradient id="b" href="#a"/></defs><rect width="24" height="24" fill="url(#a)"/>'
    ),
    expect: 'render'
  },
  {
    id: 'clip-self-cycle',
    markup: svg('<defs><clipPath id="c" clip-path="url(#c)"><rect width="24" height="24"/></clipPath></defs><rect width="24" height="24" fill="#f00" clip-path="url(#c)"/>'),
    expect: 'render'
  },
  {
    id: 'mask-self-cycle',
    markup: svg('<defs><mask id="m" mask="url(#m)"><rect width="24" height="24" fill="#fff"/></mask></defs><rect width="24" height="24" fill="#f00" mask="url(#m)"/>'),
    expect: 'render'
  },
  { id: 'text-64-huge-font', markup: svg(`<text x="0" y="20" font-size="100000" fill="#f00">${'W'.repeat(64)}</text>`), expect: 'render' },
  { id: 'uppercase-root', markup: '<SVG viewBox="0 0 24 24"><path d="M0 0h24v24z"/></SVG>', expect: 'reject' },
  { id: 'elements-1025', markup: svg(repeat(1024, () => '<path d="M0 0h1v1z"/>')), expect: 'reject' },
  { id: 'mask-fan-out', markup: maskFan(24), expect: 'render' },
  {
    id: 'clip-chain',
    // 60 clip-path references: over the layer budget.
    markup: svg(
      `<defs>${repeat(60, (i) => `<clipPath id="c${i}"${i < 59 ? ` clip-path="url(#c${i + 1})"` : ''}><rect width="24" height="24"/></clipPath>`)}</defs><rect width="24" height="24" clip-path="url(#c0)"/>`
    ),
    expect: 'reject'
  },
  {
    id: 'tiny-dashes',
    markup: svg('<path d="M0 0L1000000 1000000" stroke="#f00" stroke-width="2" stroke-dasharray="0.0001"/>'),
    expect: 'render'
  },
  { id: 'huge-stroke', markup: svg('<path d="M0 0L24 24" stroke="#f00" stroke-width="1e30"/>'), expect: 'render' },
  {
    id: 'pattern-tiles',
    markup: svg('<pattern id="p" width="0.0001" height="0.0001" patternUnits="userSpaceOnUse"><rect width="1" height="1"/></pattern><rect width="24" height="24" fill="url(#p)"/>'),
    expect: 'render'
  },
  { id: 'oversize', markup: svg(`<path d="M0 0h24v24z"/>${' '.repeat(64 * 1024)}`), expect: 'reject' },
  {
    id: 'fragment-gradient',
    markup: svg(
      '<defs><linearGradient id="g" href="#h"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)"/>'
    ),
    expect: 'render'
  },
  { id: 'numeric-refs', markup: svg('<title>&#x3C;script&#x3E;x()&#60;/script&#62;</title><path d="M0 0h24v24z"/>'), expect: 'render' },
  { id: 'quote-break', markup: svg(`<path d='M0 0h24v24z" onload="x()'/>`), expect: 'render' }
]
