import { deepStrictEqual, ok } from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { crop, diffImages, readPng, writePng } from './pixels.ts'
import { renderWithXtermJs, type XtermRenderOptions } from './xterm-chromium.ts'

const out = process.argv[2] ?? '/tmp/gpuix-t1/smoke'
mkdirSync(out, { recursive: true })

const PAPER_TTF = '/tmp/gpuix-t1/PaperMono.ttf'
const PAPER_WOFF2 = '/root/termul/src/renderer/assets/fonts/paper-mono/PaperMono[wght].woff2'
const BG = [0x0d, 0x0d, 0x0d]

function pass(label: string, detail: unknown = ''): void {
  console.log(`ok ${label}`, typeof detail === 'string' ? detail : JSON.stringify(detail))
}

async function lavfiPng(path: string, color: string, size: string): Promise<void> {
  const proc = Bun.spawn([
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${size}`,
    '-frames:v',
    '1',
    path
  ])
  ok((await proc.exited) === 0, `ffmpeg lavfi ${color} ${size}`)
}

async function pixelSmoke(): Promise<void> {
  await lavfiPng(`${out}/red.png`, 'red', '64x64')
  await lavfiPng(`${out}/blue.png`, 'blue', '64x64')
  await lavfiPng(`${out}/red80x48.png`, 'red', '80x48')
  const [red, blue, wide] = await Promise.all([
    readPng(`${out}/red.png`),
    readPng(`${out}/blue.png`),
    readPng(`${out}/red80x48.png`)
  ])
  const exact = {
    width: 3,
    height: 2,
    data: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 1, 2, 3, 128, 64, 32, 250, 251, 252])
  }
  await writePng(`${out}/exact.png`, exact)
  deepStrictEqual(
    [...(await readPng(`${out}/exact.png`)).data],
    [...exact.data],
    'rgb24 survives a png round trip byte for byte'
  )
  pass('exact png round trip', '3x2')

  const rb = await diffImages(red, blue, { outDiff: `${out}/diff-red-blue.png` })
  deepStrictEqual(rb, { width: 64, height: 64, total: 4096, differing: 4096, percent: 100 })
  pass('red vs blue', rb)
  const rr = await diffImages(red, red, { outDiff: `${out}/diff-red-red.png` })
  deepStrictEqual(rr, { width: 64, height: 64, total: 4096, differing: 0, percent: 0 })
  pass('red vs red', rr)
  const mismatch = await diffImages(red, wide)
  deepStrictEqual(mismatch.sizeMismatch, { a: [64, 64], b: [80, 48] })
  deepStrictEqual([mismatch.width, mismatch.height, mismatch.percent], [64, 48, 0])
  pass('size mismatch', mismatch)

  const diffRb = await readPng(`${out}/diff-red-blue.png`)
  const diffRr = await readPng(`${out}/diff-red-red.png`)
  deepStrictEqual([...diffRb.data.subarray(0, 3)], [255, 0, 0], 'differing pixel is red')
  deepStrictEqual([...diffRr.data.subarray(0, 3)], [23, 23, 23], 'equal pixel is dimmed grey')
  pass('diff png pixels', {
    differing: [...diffRb.data.subarray(0, 3)],
    equal: [...diffRr.data.subarray(0, 3)]
  })

  const patch = crop(blue, 10, 20, 7, 5)
  await writePng(`${out}/crop.png`, patch)
  const back = await readPng(`${out}/crop.png`)
  deepStrictEqual([back.width, back.height, back.data.length], [7, 5, 105])
  deepStrictEqual((await diffImages(patch, back)).differing, 0, 'crop survives a png round trip')
  pass('crop + writePng round trip', `${back.width}x${back.height}`)
}

const SAMPLE = new TextEncoder().encode(
  `hello \x1b[31mred\x1b[0m world\r\n\x1b[48;2;20;80;200m truecolor \x1b[0m\r\n${'x'.repeat(100)}\r\n$ `
)

function baseOptions(fontPath: string, outPng: string, bytes: Uint8Array): XtermRenderOptions {
  return {
    bytes,
    cols: 80,
    rows: 24,
    fontFamily: '"Paper Mono", monospace',
    fontFiles: [{ family: 'Paper Mono', path: fontPath }],
    fontSize: 14,
    lineHeight: 1.2,
    theme: { background: '#0d0d0d', foreground: '#e6e6e6', cursor: '#e6e6e6', red: '#ff5f56' },
    scrollback: 10000,
    outPng,
    timing: true
  }
}

async function xtermSmoke(): Promise<void> {
  ok(existsSync(PAPER_TTF), `${PAPER_TTF} exists`)
  const expectedRows = [
    'hello red world',
    ' truecolor ',
    'x'.repeat(80),
    'x'.repeat(20),
    '$ ',
    ...Array(19).fill('')
  ]
  const results = []
  for (const [name, font] of [
    ['ttf', PAPER_TTF],
    ['woff2', PAPER_WOFF2]
  ] as const) {
    const png = `${out}/xterm-${name}.png`
    const r = await renderWithXtermJs(baseOptions(font, png, SAMPLE))
    deepStrictEqual(r.rows, expectedRows)
    deepStrictEqual(r.cursor, { x: 2, y: 4 })
    deepStrictEqual(r.bufferLength, 24)
    const img = await readPng(png)
    deepStrictEqual(
      [img.width, img.height],
      [r.screenBox.width, r.screenBox.height],
      'png size equals screenBox'
    )
    deepStrictEqual(
      [r.cellWidth * 80, r.cellHeight * 24],
      [r.screenBox.width, r.screenBox.height],
      'screen is cols x rows cells'
    )
    pass(`xterm ${name}`, {
      cell: [r.cellWidth, r.cellHeight],
      screenBox: r.screenBox,
      writeMs: r.writeMs,
      renderMs: r.renderMs
    })
    results.push({ r, img })
  }
  const [ttf, woff2] = results
  ok(ttf && woff2)
  deepStrictEqual([ttf.r.cellWidth, ttf.r.cellHeight], [woff2.r.cellWidth, woff2.r.cellHeight])
  deepStrictEqual(
    (await diffImages(ttf.img, woff2.img)).differing,
    0,
    'ttf and woff2 renders are identical'
  )
  pass('ttf vs woff2 pixels', '0 differing')

  const cell = ttf.r
  const truecolor = crop(
    ttf.img,
    Math.round(cell.cellWidth * 4),
    Math.round(cell.cellHeight * 1) + 1,
    1,
    1
  )
  deepStrictEqual([...truecolor.data], [20, 80, 200], 'truecolor background cell')
  pass('truecolor cell pixel', [...truecolor.data])

  const webgl = await renderWithXtermJs({
    ...baseOptions(PAPER_TTF, `${out}/xterm-webgl.png`, SAMPLE),
    renderer: 'webgl'
  })
  deepStrictEqual(webgl.rows, expectedRows)
  pass('xterm webgl rows', { cell: [webgl.cellWidth, webgl.cellHeight] })

  const seq = new TextEncoder().encode(
    Array.from({ length: 200000 }, (_, i) => `${i + 1}\r\n`).join('')
  )
  const big = await renderWithXtermJs(baseOptions(PAPER_TTF, `${out}/xterm-seq.png`, seq))
  deepStrictEqual(big.rows.slice(-3), ['199999', '200000', ''])
  deepStrictEqual(big.bufferLength, 10024)
  const seqImg = await readPng(`${out}/xterm-seq.png`)
  const corner = crop(seqImg, seqImg.width - 16, seqImg.height - 19, 16, 19)
  const stray = [...corner.data].filter((v, i) => v !== BG[i % 3]).length
  deepStrictEqual(stray, 0, 'no scrollbar or shadow painted over the bottom-right cells')
  pass('xterm seq 200000', {
    bytes: seq.length,
    writeMs: big.writeMs,
    renderMs: big.renderMs,
    bufferLength: big.bufferLength
  })
}

await pixelSmoke()
await xtermSmoke()
console.log('all smoke checks passed')
