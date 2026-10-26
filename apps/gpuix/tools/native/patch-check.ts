/**
 * On-screen check of Termul's @gpuix/native patches. Runs `patch-scene.tsx`
 * under Xvfb + lavapipe with whatever addon NAPI_RS_NATIVE_LIBRARY_PATH picks,
 * grabs the window and asserts what each patch paints:
 *
 *   0001-font-style        `fontStyle: 'italic'` picks Inter's italic face
 *   0002-markdown-theme    a markdown link paints in `theme.link`;
 *                          `mdInlineCodeScale: 0.5` halves inline-code glyphs
 *   0003-window-handle     `getNativeWindowHandle()` names this X11 window
 *   0004-input-unfocused-scroll
 *                          an unfocused input given a long value shows its
 *                          start, not the end with the caret (URL-INPUT)
 *   zed/0003 + gpuix/0005  `backdropBlur` flattens the stripes under its box,
 *   backdrop-blur          leaves the stripes beside it and outside its
 *                          rounded corner sharp
 *   zed/0004 + gpuix/0007  inline-code padding takes layout space: the text
 *   run-padding            after a chip padded by CODE_PAD moves 2 x CODE_PAD
 *   0006-focus-events      `focus-check.ts`: an active window gets the DOM's
 *                          focus and blur sequence, autoFocus included
 *   0013-markdown-automation-text
 *                          the automation tree and getAllText() carry each
 *                          <markdown>'s rendered text
 *   0010-table-cell-metrics
 *                          a table row is 2 x mdTableCellPaddingY + mdTableLineHeight
 *                          tall and the header row paints tableHeaderBg
 *   zed/0005-fractional-line-height
 *                          `typo-check.ts`: 13px/19.5 and 12px/19.5 lines sit
 *                          19.5 px apart, each line's ink where Chromium puts it
 *   run-width              `typo-check.ts`: a line's ink width is Chromium's
 *                          (font-render-hinting slight) within 0.3%
 *   zed/0006 + gpuix/0007  `typo-check.ts`: inline-code washes, mid-line and
 *   inline-code-wash       leading a line, start and end within 1 px of
 *                          Chromium's chips
 *   0012-table-columns-rules
 *                          `typo-check.ts`: fullscreen table labels start and
 *                          rules sit within 1 px of Chromium's
 *   0014-table-fractional-cell-padding
 *                          `typo-check.ts`: transcript table rules 30.6 px
 *                          apart, each within 1 px of Chromium's
 *   0015-markdown-lead-tabular-nums
 *                          `typo-check.ts`: an ordered item's line ends where
 *                          Chromium's tabular list marker puts it
 *   0016-grid-span         a gridColumnSpan cell spans its columns
 *   zed/0007 + gpuix/0017  `letterSpacing` in em widens the ink of a run by
 *   letter-spacing         the spacing between each pair of glyphs
 *   0018-markdown-list-marker
 *                          `listBullet` paints in `listMarker`, centred in
 *                          an `mdListMarkerWidth` column, with the item text
 *                          `mdListMarkerGap` after it
 *   zed/0008 + gpuix/0019  a track list and a column start place a cell in
 *   grid-tracks-placement  the last track of 100px 1fr 50px, and a cell in a
 *                          fixed track sizes its row by its content
 *   0008-prompt-for-new-path
 *                          `dialog-check.ts`: the portal's save dialog returns
 *                          the path typed into it
 *
 * On the published addon every assertion fails, which is what makes it a test.
 *
 * NAPI_RS_NATIVE_LIBRARY_PATH=native/gpuix-native/build/gpuix-native.linux-x64-gnu.node \
 *   bun tools/native/patch-check.ts [--out DIR]
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import {
  grabFrame,
  LAVAPIPE_ICD,
  SCREEN_MARGIN,
  startXvfb,
  windowOrigin
} from '../parity/shoot-gpuix'
import {
  type AutomationNode,
  BLUR,
  BULLET,
  CODE_PAD,
  GRID,
  GRID_TRACKS,
  type Sample,
  SCENE,
  type SceneReady,
  TABLE,
  TRACKING
} from './samples'
import type { TypoRow } from './typo-samples'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: '/tmp/gpuix-native-patch-check' } }
})
const out = path.resolve(values.out as string)
mkdirSync(out, { recursive: true })
const readyFile = path.join(out, 'ready.json')
const shot = path.join(out, 'scene.png')
if (existsSync(readyFile)) unlinkSync(readyFile)

const xvfb = await startXvfb(SCENE.width + SCREEN_MARGIN, SCENE.height + SCREEN_MARGIN)
const scene = Bun.spawn(['bun', path.join(import.meta.dir, 'patch-scene.tsx'), readyFile], {
  env: {
    ...process.env,
    DISPLAY: xvfb.display,
    VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
    GPUIX_BACKGROUND: '1'
  },
  stdout: 'inherit',
  stderr: 'inherit'
})
let ready: SceneReady
let xwininfo: string
try {
  const deadline = Date.now() + 60_000
  while (!existsSync(readyFile)) {
    if (scene.exitCode !== null) throw new Error(`patch scene exited ${scene.exitCode}`)
    if (Date.now() > deadline) throw new Error('patch scene never wrote its ready file')
    await Bun.sleep(50)
  }
  await Bun.sleep(300)
  const origin = await windowOrigin(xvfb.display, SCENE.width, SCENE.height)
  await grabFrame(xvfb.display, SCENE.width, SCENE.height, shot, origin)
  ready = JSON.parse(readFileSync(readyFile, 'utf8')) as SceneReady
  xwininfo = Bun.spawnSync([
    'xwininfo',
    '-root',
    '-tree',
    '-display',
    xvfb.display
  ]).stdout.toString()
} finally {
  scene.kill()
  await scene.exited
  xvfb.stop()
}

const png = PNG.sync.read(readFileSync(shot))
const pixel = (x: number, y: number) => {
  const i = (y * png.width + x) * 4
  return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0] as const
}
function region(sample: Sample) {
  const b = ready.bounds[sample]
  if (!b) throw new Error(`${sample} has no bounds`)
  if (b.x + b.width > png.width || b.y + b.height > png.height)
    throw new Error(
      `${sample} at ${JSON.stringify(b)} is outside the ${png.width}x${png.height} window`
    )
  return {
    x0: Math.round(b.x),
    y0: Math.round(b.y),
    x1: Math.round(b.x + b.width),
    y1: Math.round(b.y + b.height)
  }
}
const lit = ([r, g, b]: readonly [number, number, number]) => r + g + b > 384

/** Mean x of lit pixels in the top third of the ink minus the bottom third, per pixel of height. */
function slant(sample: Sample): number {
  const { x0, y0, x1, y1 } = region(sample)
  const rows: Array<{ y: number; xs: number[] }> = []
  for (let y = y0; y < y1; y++) {
    const xs: number[] = []
    for (let x = x0; x < x1; x++) if (lit(pixel(x, y))) xs.push(x)
    if (xs.length) rows.push({ y, xs })
  }
  const third = Math.max(1, Math.floor(rows.length / 3))
  const mean = (part: typeof rows) => {
    const xs = part.flatMap((r) => r.xs)
    return xs.reduce((a, b) => a + b, 0) / xs.length
  }
  const top = rows.slice(0, third)
  const bottom = rows.slice(-third)
  const dy = (bottom.at(-1)?.y ?? 0) - (top[0]?.y ?? 0) - third
  return (mean(top) - mean(bottom)) / Math.max(1, dy)
}

function count(sample: Sample, test: (rgb: readonly [number, number, number]) => boolean): number {
  const { x0, y0, x1, y1 } = region(sample)
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (test(pixel(x, y))) n++
  return n
}

function litIn(x0: number, x1: number, y0: number, y1: number): number {
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (lit(pixel(x, y))) n++
  return n
}

function inkWidth(sample: Sample): number {
  const { x0, y0, x1, y1 } = region(sample)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (lit(pixel(x, y))) {
        min = Math.min(min, x)
        max = Math.max(max, x)
      }
  return max >= min ? max - min + 1 : 0
}

const gridPlaced = {
  left: (ready.bounds.gridPlaced?.x ?? 0) - (ready.bounds.gridTracks?.x ?? 0),
  width: ready.bounds.gridPlaced?.width ?? 0
}
const uprightSlant = slant('upright')
const italicSlant = slant('italic')
const linkRed = count('link', ([r, g, b]) => r > 160 && g < 90 && b < 90)
const codeRatio = inkWidth('codeHalf') / Math.max(1, inkWidth('codeFull'))
const codePadShift = inkWidth('codePad') - inkWidth('codeTight')
const trackingShift = inkWidth('tracked') - inkWidth('untracked')
const trackingExpected = TRACKING.em * TRACKING.size * (TRACKING.glyphs - 1)
/** Mean x of the bullet's red ink, and the first x of the item's white ink, from the list's left edge. */
const bulletInk = (() => {
  const { x0, y0, x1, y1 } = region('bullet')
  const red: number[] = []
  let white = Number.POSITIVE_INFINITY
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = pixel(x, y)
      if (r > 160 && g < 90 && b < 90) red.push(x)
      else if (lit([r, g, b])) white = Math.min(white, x)
    }
  const left = x0 + 8
  const centre = red.length ? red.reduce((a, b) => a + b, 0) / red.length - left : -1
  return { centre: Math.round(centre * 10) / 10, text: white - left, red: red.length }
})()
/** The item's M starts at the column plus the gap, past Paper Mono's left bearing at 32 px (measured on `untracked`). */
const bearing = (() => {
  const { x0, y0, x1, y1 } = region('untracked')
  for (let x = x0; x < x1; x++) if (litIn(x, x + 1, y0, y1) > 0) return x - (x0 + 8)
  return 0
})()
const inputStartInk = (() => {
  const { x0, y0, x1, y1 } = region('input')
  return litIn(x0, x1, y0, Math.round((y0 + y1) / 2))
})()
/** Mean distance from mid-grey of the stripes on the middle row, over [from, to) of the stripe strip. */
function stripeContrast(from: number, to: number): number {
  const { x0, y0 } = region('blur')
  const y = y0 + 8 + BLUR.height / 2
  let sum = 0
  for (let x = x0 + 8 + from; x < x0 + 8 + to; x++) sum += Math.abs(pixel(x, y)[0] - 127.5)
  return sum / (to - from)
}
const half = BLUR.width / 2
const sharpStripes = stripeContrast(16, half - 16)
const blurredStripes = stripeContrast(half + 3 * BLUR.sigma, BLUR.width - 3 * BLUR.sigma)
const cornerStripe = (() => {
  const { x0, y0 } = region('blur')
  return pixel(x0 + 8 + half + 1, y0 + 8 + 1)[0]
})()
const red = ([r, g, b]: readonly [number, number, number]) => r > 200 && g < 60 && b < 60
/** Rows of the table sample holding the header fill, and the table's height inside the 8 px box padding. */
const tableFillRows = (() => {
  const { x0, y0, x1, y1 } = region('table')
  let rows = 0
  for (let y = y0; y < y1; y++) {
    let n = 0
    for (let x = x0; x < x1; x++) if (red(pixel(x, y))) n++
    if (n >= 100) rows++
  }
  return rows
})()
const tableHeight = (() => {
  const b = ready.bounds.table
  return b ? Math.round(b.height - 16) : 0
})()
const tableRow = 2 * TABLE.padY + TABLE.lineHeight
const markdownTexts = (function walk(node: AutomationNode | null | undefined): string[] {
  if (!node) return []
  const own = node.type === 'markdown' && node.text !== undefined ? [node.text] : []
  return [...own, ...(node.children ?? []).flatMap(walk)]
})(ready.tree)
const handleId = ready.handle?.kind === 'x11' ? ready.handle.id : null
const handleWindow =
  typeof handleId === 'number'
    ? (xwininfo.match(
        new RegExp(
          `0x${handleId.toString(16)} "termul-native-patch-check".*${SCENE.width}x${SCENE.height}`
        )
      ) ?? null)
    : null

const focusRun = Bun.spawnSync(
  ['bun', path.join(import.meta.dir, 'focus-check.ts'), '--out', path.join(out, 'focus')],
  { env: process.env }
)
const focusLines = focusRun.stdout.toString().trim().split('\n')
const dialogRun = Bun.spawnSync(
  ['bun', path.join(import.meta.dir, 'dialog-check.ts'), '--out', path.join(out, 'dialog')],
  { env: process.env }
)
const dialogLines = dialogRun.stdout.toString().trim().split('\n')
const typoOut = path.join(out, 'typo')
Bun.spawnSync(['bun', path.join(import.meta.dir, 'typo-check.ts'), '--out', typoOut], {
  env: process.env
})
const typoRows: TypoRow[] = existsSync(path.join(typoOut, 'rows.json'))
  ? JSON.parse(readFileSync(path.join(typoOut, 'rows.json'), 'utf8'))
  : [{ patch: 'typo-check', what: 'typo-check.ts wrote its rows', value: null, ok: false }]

const checks = [
  {
    patch: '0001-font-style',
    what: 'upright strokes stand straight',
    value: uprightSlant,
    ok: Math.abs(uprightSlant) < 0.05
  },
  {
    patch: '0001-font-style',
    what: "fontStyle 'italic' picks Inter Italic, whose strokes slant about 0.19",
    value: italicSlant,
    ok: italicSlant > 0.12 && italicSlant < 0.26
  },
  {
    patch: '0002-markdown-theme',
    what: 'link pixels in theme.link red',
    value: linkRed,
    ok: linkRed > 100
  },
  {
    patch: '0002-markdown-theme',
    what: 'mdInlineCodeScale 0.5 halves the code ink width',
    value: codeRatio,
    ok: codeRatio > 0.4 && codeRatio < 0.6
  },
  {
    patch: '0003-window-handle',
    what: 'getNativeWindowHandle names the scene window',
    value: ready.handle,
    ok: handleWindow !== null
  },
  {
    patch: 'run-padding',
    what: `inline-code padding ${CODE_PAD} widens M\`M\`M by twice the padding (px)`,
    value: codePadShift,
    ok: Math.abs(codePadShift - 2 * CODE_PAD) <= 1
  },
  {
    patch: '0016-grid-span',
    what: `gridColumnSpan ${GRID.span} in a ${GRID.columns}-column grid ${GRID.width} px wide spans ${(GRID.width * GRID.span) / GRID.columns} px (px)`,
    value: ready.bounds.gridSpan?.width ?? 0,
    ok: Math.abs((ready.bounds.gridSpan?.width ?? 0) - (GRID.width * GRID.span) / GRID.columns) <= 1
  },
  {
    patch: 'grid-tracks-placement',
    what: `a cell at gridColumnStart ${GRID_TRACKS.column} of tracks 100px 1fr 50px in ${GRID_TRACKS.width} px starts ${GRID_TRACKS.left} px in and is ${GRID_TRACKS.cell} px wide (px)`,
    value: gridPlaced,
    ok:
      Math.abs(gridPlaced.left - GRID_TRACKS.left) <= 1 &&
      Math.abs(gridPlaced.width - GRID_TRACKS.cell) <= 1
  },
  {
    patch: 'grid-tracks-placement',
    what: `a content-sized cell in the 100 px track gives the row its ${GRID_TRACKS.contentHeight} px content height (px)`,
    value: ready.bounds.gridTracks?.height ?? 0,
    ok: Math.abs((ready.bounds.gridTracks?.height ?? 0) - GRID_TRACKS.contentHeight) <= 1
  },
  {
    patch: 'letter-spacing',
    what: `letterSpacing ${TRACKING.em}em on ${TRACKING.glyphs} glyphs of ${TRACKING.size} px widens the ink by ${trackingExpected} px (px)`,
    value: trackingShift,
    ok: Math.abs(trackingShift - trackingExpected) <= 1
  },
  {
    patch: '0018-markdown-list-marker',
    what: `listBullet paints in listMarker, centred in a ${BULLET.width} px column (centre x, red pixels)`,
    value: bulletInk,
    ok: bulletInk.red > 10 && Math.abs(bulletInk.centre - BULLET.width / 2) <= 1
  },
  {
    patch: '0018-markdown-list-marker',
    what: `the item text starts ${BULLET.width} + ${BULLET.gap} px plus the glyph bearing (${bearing} px) from the list (px)`,
    value: bulletInk.text,
    ok: Math.abs(bulletInk.text - (BULLET.width + BULLET.gap + bearing)) <= 1
  },
  {
    patch: '0010-table-cell-metrics',
    what: `mdTableCellPaddingY ${TABLE.padY} and mdTableLineHeight ${TABLE.lineHeight} give ${TABLE.rows} rows of ${tableRow} px and a 1 px rule (px)`,
    value: tableHeight,
    ok: tableHeight === TABLE.rows * tableRow + 1
  },
  {
    patch: '0010-table-cell-metrics',
    what: `tableHeaderBg fills the header row, ${tableRow} px tall (rows)`,
    value: tableFillRows,
    ok: Math.abs(tableFillRows - tableRow) <= 1
  },
  {
    patch: '0013-markdown-automation-text',
    what: 'the automation tree gives each <markdown> its rendered text (link, chip run, table rows)',
    value: markdownTexts,
    ok: ['lllllll', 'MMM', 'A\tB\nc\td'].every((text) => markdownTexts.includes(text))
  },
  {
    patch: '0013-markdown-automation-text',
    what: 'getAllText() includes the <markdown> text',
    value: ready.allText.filter((text) => text.includes('lllllll')),
    ok: ready.allText.includes('lllllll')
  },
  {
    patch: '0004-input-unfocused-scroll',
    what: 'unfocused input shows the start of a long value (ink above the baseline)',
    value: inputStartInk,
    ok: inputStartInk > 150
  },
  {
    patch: 'backdrop-blur',
    what: 'stripes beside the box stay sharp (distance from grey, 127.5 is sharp)',
    value: sharpStripes,
    ok: sharpStripes > 120
  },
  {
    patch: 'backdrop-blur',
    what: `backdropBlur ${BLUR.sigma} flattens the stripes under the box (0 is flat)`,
    value: blurredStripes,
    ok: blurredStripes < 8
  },
  {
    patch: 'backdrop-blur',
    what: 'the rounded corner leaves its outside pixel sharp (0 or 255)',
    value: cornerStripe,
    ok: cornerStripe === 0 || cornerStripe === 255
  },
  {
    patch: '0006-focus-events',
    what: 'an active window gets the DOM focus and blur events at every focus-check step',
    value: focusLines.filter((line) => line.startsWith('FAIL')),
    ok: focusRun.exitCode === 0
  },
  {
    patch: '0008-prompt-for-new-path',
    what: 'the open, save and cancelled portal dialogs resolve as dialog-check expects',
    value: dialogLines.filter((line) => line.startsWith('FAIL')),
    ok: dialogRun.exitCode === 0
  },
  ...typoRows
]
for (const check of checks)
  console.log(
    `${check.ok ? 'PASS' : 'FAIL'} ${check.patch} ${check.what}: ${JSON.stringify(check.value)}`
  )
console.log(`screenshot ${shot}`)
if (checks.some((check) => !check.ok)) process.exit(1)
