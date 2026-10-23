import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { chromium, type Page } from 'playwright'

export interface XtermRenderOptions {
  bytes: Uint8Array
  cols: number
  rows: number
  fontFamily: string
  fontFiles: { family: string; path: string; weight?: number }[]
  fontSize: number
  lineHeight: number
  theme: Record<string, string>
  scrollback: number
  chunkSize?: number
  outPng: string
  background?: string
  renderer?: 'dom' | 'webgl'
  timing?: boolean
}

export interface XtermRenderResult {
  rows: string[]
  cursor: { x: number; y: number }
  cellWidth: number
  cellHeight: number
  screenBox: { x: number; y: number; width: number; height: number }
  writeMs?: number
  renderMs?: number
  bufferLength: number
}

interface PageInput {
  b64: string
  cols: number
  rows: number
  fontFamily: string
  fontSize: number
  lineHeight: number
  theme: Record<string, string>
  scrollback: number
  chunkSize: number
  renderer: 'dom' | 'webgl'
  families: string[]
}

type PageOutput = Omit<XtermRenderResult, 'screenBox' | 'writeMs' | 'renderMs'> & {
  writeMs: number
  renderMs: number
}

const ORIGIN = 'http://xterm.local'
const XTERM_DIR = '/root/termul/node_modules/@xterm'

const FONT_FORMATS: Record<string, { format: string; mime: string }> = {
  '.ttf': { format: 'truetype', mime: 'font/ttf' },
  '.otf': { format: 'opentype', mime: 'font/otf' },
  '.woff': { format: 'woff', mime: 'font/woff' },
  '.woff2': { format: 'woff2', mime: 'font/woff2' }
}

function fontFormat(path: string): { format: string; mime: string } {
  const format = FONT_FORMATS[extname(path).toLowerCase()]
  if (!format) throw new Error(`unsupported font file extension: ${path}`)
  return format
}

function buildHtml(opts: XtermRenderOptions): string {
  const background = opts.background ?? opts.theme.background ?? '#000000'
  const faces = opts.fontFiles
    .map((font, i) => {
      const weight = font.weight === undefined ? '' : `font-weight:${font.weight};`
      return `@font-face{font-family:"${font.family}";src:url("/fonts/${i}${extname(font.path)}") format("${fontFormat(font.path).format}");${weight}}`
    })
    .join('\n')
  const webgl = opts.renderer === 'webgl' ? '<script src="/addon-webgl.js"></script>' : ''
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/xterm.css">
<style>html,body{margin:0;padding:0;background:${background}}#term{position:absolute;left:0;top:0}
.xterm .xterm-scrollable-element>.xterm-scrollbar,.xterm .xterm-scrollable-element>.xterm-shadow{display:none!important}
${faces}</style></head><body><div id="term"></div>
<script src="/xterm.js"></script>${webgl}</body></html>`
}

async function serve(page: Page, opts: XtermRenderOptions): Promise<void> {
  const files: Record<string, { path: string; mime: string }> = {
    '/xterm.js': { path: `${XTERM_DIR}/xterm/lib/xterm.js`, mime: 'text/javascript' },
    '/xterm.css': { path: `${XTERM_DIR}/xterm/css/xterm.css`, mime: 'text/css' },
    '/addon-webgl.js': {
      path: `${XTERM_DIR}/addon-webgl/lib/addon-webgl.js`,
      mime: 'text/javascript'
    }
  }
  opts.fontFiles.forEach((font, i) => {
    files[`/fonts/${i}${extname(font.path)}`] = {
      path: font.path,
      mime: fontFormat(font.path).mime
    }
  })
  const html = buildHtml(opts)
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html })
    const file = files[path]
    if (!file) return route.fulfill({ status: 404, body: 'not found' })
    const body = Buffer.from(await Bun.file(file.path).arrayBuffer())
    return route.fulfill({ status: 200, contentType: file.mime, body })
  })
}

interface XtermLine {
  translateToString(trimRight: boolean): string
}
interface XtermLike {
  open(el: HTMLElement): void
  focus(): void
  write(data: Uint8Array, cb?: () => void): void
  loadAddon(addon: object): void
  buffer: {
    active: {
      viewportY: number
      cursorX: number
      cursorY: number
      length: number
      getLine(y: number): XtermLine | undefined
    }
  }
}
interface XtermGlobals {
  Terminal: new (options: object) => XtermLike
  WebglAddon?: { WebglAddon: new () => object }
}

async function runInPage(input: PageInput): Promise<PageOutput> {
  const g = globalThis as unknown as XtermGlobals
  for (const family of input.families) await document.fonts.load(`${input.fontSize}px "${family}"`)
  for (const face of document.fonts) await face.load()
  await document.fonts.ready
  const failed = [...document.fonts]
    .filter((face) => face.status !== 'loaded')
    .map((face) => face.family)
  if (failed.length > 0) throw new Error(`fonts failed to load: ${failed.join(', ')}`)

  const term = new g.Terminal({
    cols: input.cols,
    rows: input.rows,
    fontFamily: input.fontFamily,
    fontSize: input.fontSize,
    lineHeight: input.lineHeight,
    theme: input.theme,
    scrollback: input.scrollback,
    allowTransparency: false,
    cursorBlink: false,
    cursorStyle: 'block',
    tabStopWidth: 4,
    convertEol: false,
    allowProposedApi: true
  })
  const host = document.getElementById('term')
  if (!host) throw new Error('missing #term host')
  term.open(host)
  if (input.renderer === 'webgl') {
    if (!g.WebglAddon) throw new Error('webgl addon script did not load')
    term.loadAddon(new g.WebglAddon.WebglAddon())
  }
  term.focus()

  const raw = atob(input.b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve))

  const start = performance.now()
  await new Promise<void>((resolve) => {
    if (bytes.length === 0) return resolve()
    for (let offset = 0; offset < bytes.length; offset += input.chunkSize) {
      const end = Math.min(offset + input.chunkSize, bytes.length)
      term.write(bytes.subarray(offset, end), end === bytes.length ? resolve : undefined)
    }
  })
  const written = performance.now()
  await frame()
  const painted = performance.now()
  await frame()

  const buffer = term.buffer.active
  const rows: string[] = []
  for (let y = 0; y < input.rows; y++)
    rows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')

  const cell = (term as any)._core?._renderService?.dimensions?.css?.cell as
    | { width: number; height: number }
    | undefined
  let cellWidth = cell?.width ?? 0
  let cellHeight = cell?.height ?? 0
  if (!(cellWidth > 0 && cellHeight > 0)) {
    const screen = host.querySelector('.xterm-screen')
    const firstRow = host.querySelector('.xterm-rows > div')
    cellWidth = (screen?.getBoundingClientRect().width ?? 0) / input.cols
    cellHeight = firstRow?.getBoundingClientRect().height ?? 0
  }

  return {
    rows,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    cellWidth,
    cellHeight,
    bufferLength: buffer.length,
    writeMs: written - start,
    renderMs: painted - start
  }
}

export async function renderWithXtermJs(opts: XtermRenderOptions): Promise<XtermRenderResult> {
  const renderer = opts.renderer ?? 'dom'
  const browser = await chromium.launch({
    args: renderer === 'webgl' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []
  })
  try {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      viewport: { width: 1600, height: 1000 }
    })
    const page = await context.newPage()
    await serve(page, opts)
    await page.goto(`${ORIGIN}/`)
    const input: PageInput = {
      b64: Buffer.from(opts.bytes).toString('base64'),
      cols: opts.cols,
      rows: opts.rows,
      fontFamily: opts.fontFamily,
      fontSize: opts.fontSize,
      lineHeight: opts.lineHeight,
      theme: opts.theme,
      scrollback: opts.scrollback,
      chunkSize: opts.chunkSize ?? 65536,
      renderer,
      families: [...new Set(opts.fontFiles.map((font) => font.family))]
    }
    const out = await page.evaluate(runInPage, input)
    const screen = page.locator('.xterm-screen')
    const box = await screen.boundingBox()
    if (!box) throw new Error('.xterm-screen has no bounding box')
    const needW = Math.ceil(box.x + box.width)
    const needH = Math.ceil(box.y + box.height)
    if (needW > 1600 || needH > 1000) {
      await page.setViewportSize({
        width: Math.max(1600, needW + 40),
        height: Math.max(1000, needH + 40)
      })
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
    }
    await page.screenshot({
      path: opts.outPng,
      clip: box,
      animations: 'disabled',
      caret: 'initial'
    })
    const { writeMs, renderMs, ...rest } = out
    const result: XtermRenderResult = { ...rest, screenBox: box }
    if (opts.timing) Object.assign(result, { writeMs, renderMs })
    return result
  } finally {
    await browser.close()
  }
}

async function main(argv: string[]): Promise<void> {
  const [bytesPath, outPng, cols = '80', rows = '24'] = argv
  if (!bytesPath || !outPng) {
    console.error('usage: bun tools/terminal/xterm-chromium.ts <bytes.bin> <out.png> [cols rows]')
    process.exit(2)
  }
  const paperMono = '/tmp/gpuix-t1/PaperMono.ttf'
  const fontFamily = existsSync(paperMono) ? 'Paper Mono' : 'DejaVu Sans Mono'
  const { rows: _rows, ...summary } = await renderWithXtermJs({
    bytes: new Uint8Array(await Bun.file(bytesPath).arrayBuffer()),
    cols: Number(cols),
    rows: Number(rows),
    fontFamily,
    fontFiles: fontFamily === 'Paper Mono' ? [{ family: fontFamily, path: paperMono }] : [],
    fontSize: 14,
    lineHeight: 1.2,
    theme: { background: '#0d0d0d', foreground: '#e6e6e6', cursor: '#e6e6e6', red: '#ff5f56' },
    scrollback: 10000,
    outPng,
    timing: true
  })
  console.log(JSON.stringify({ fontFamily, ...summary }, null, 2))
}

if (import.meta.main) await main(process.argv.slice(2))
