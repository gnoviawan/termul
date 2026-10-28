/**
 * Runs every hostile SVG in `svg-attacks.ts` through the GPUIX client under
 * Xvfb + lavapipe, one process per attack so an abort names its input, then
 * the grid of bundled icons and attacks in one window.
 *
 *   app (default)  the app path (`svg-attack-scene.tsx one`): asserts the
 *                  process survives, the native decode of what compat hands
 *                  the renderer takes under BUDGET_MS, and no frame after it
 *                  holds the UI thread past HANG_MS; then the grid, asserting every bundled icon
 *                  paints and matches G16's pixels.
 *   raw            the markup straight to GPUIX (`raw`): reports what the
 *                  native renderer does on its own, asserts nothing.
 *   chat           every `CHAT_IMAGES` entry (the raster and svgz bombs of
 *                  `image-attacks.ts`, then each SVG attack) as an agent
 *                  reply's `data:` image (`chat`): asserts the process
 *                  survives and, against the green control images, spends
 *                  under CHAT_CPU_MS more CPU and peaks under CHAT_RSS_MB more
 *                  resident memory, the least of up to three runs.
 *
 * bun tools/compat/svg-attack-check.ts [--mode app|raw|chat] [--only id,id] [--no-grid] [--out DIR]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
  ATTACK_FIFO,
  ATTACK_STATE,
  bundledIcons,
  GRID_HEIGHT,
  GRID_WIDTH
} from './svg-attack-shared'
import { CHAT_IMAGES, IMAGE_ATTACKS } from './image-attacks'
import { SVG_ATTACKS } from './svg-attacks'

const BUDGET_MS = 50
/** A frame this long is the UI thread held by a render, not lavapipe jitter on a shared host. */
const HANG_MS = 250
const SCENE_TIMEOUT_MS = 30_000
/** Decode budget for one chat image, over what a 64 px green image costs. */
const CHAT_CPU_MS = 1000
const CHAT_RSS_MB = 64
const CHAT_RETRIES = 2

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: 'string', default: 'app' },
    only: { type: 'string' },
    'no-grid': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(ATTACK_STATE, 'svg-attack') }
  }
})
const mode = values.mode as 'app' | 'raw' | 'chat'
const out = path.resolve(values.out as string)
mkdirSync(out, { recursive: true })
mkdirSync(ATTACK_STATE, { recursive: true })
if (!existsSync(ATTACK_FIFO)) Bun.spawnSync(['mkfifo', ATTACK_FIFO])
const only = values.only ? new Set((values.only as string).split(',')) : null
const sceneFile = path.join(import.meta.dir, 'svg-attack-scene.tsx')

interface Result {
  alive: boolean
  cpuMs?: number
  rssGrowthMb?: number
  setImageMs: number | null
  setImageMaxMs: number | null
  setImageError: string | null
  bytes: number
  stats: { maxMs?: number; frames: number } | null
}

const xvfb = await startXvfb(GRID_WIDTH + SCREEN_MARGIN, GRID_HEIGHT + SCREEN_MARGIN)
const env = {
  ...process.env,
  DISPLAY: xvfb.display,
  VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
  GPUIX_BACKGROUND: '1'
}
const failures: string[] = []

/** One chat image's cost over the control, as `chat.json` in the out dir records it. */
export interface ChatRow {
  id: string
  cpuOverMs: number | null
  rssOverMb: number | null
  ok: boolean
}
const chatRows: ChatRow[] = []

async function runScene(id: string, sceneMode: string, index: number) {
  const file = path.join(out, `${mode}-${id.replace(/[^\w.-]/g, '_')}.json`)
  if (existsSync(file)) unlinkSync(file)
  const started = performance.now()
  const scene = Bun.spawn(['bun', sceneFile, file, sceneMode, String(index)], {
    env,
    stdout: 'ignore',
    stderr: 'pipe'
  })
  const timer = setTimeout(() => scene.kill('SIGKILL'), SCENE_TIMEOUT_MS)
  const code = await scene.exited
  clearTimeout(timer)
  const wallMs = performance.now() - started
  const stderr = await new Response(scene.stderr).text()
  const result = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Result) : null
  const abort = stderr.match(
    /thread .* has overflowed its stack|fatal runtime error[^\n]*|panicked at[^\n]*|memory allocation[^\n]*/
  )?.[0]
  const exit = `exit ${code}${scene.signalCode ? ` ${scene.signalCode}` : ''}`
  const died = code !== 0 || !result?.alive ? `${id}: process died (${exit}) ${abort ?? ''}` : null
  return { result, abort, exit, wallMs, died }
}

try {
  if (mode === 'chat') {
    for (const attack of IMAGE_ATTACKS) await attack.bytes()
    let control = null as { cpuMs: number; rssGrowthMb: number } | null
    for (const [index, image] of CHAT_IMAGES.entries()) {
      const isControl = image.id.startsWith('control-')
      if (only && !isControl && !only.has(image.id)) continue
      let run = await runScene(image.id, 'chat', index)
      let cpuMs = run.result?.cpuMs ?? 0
      let rssGrowthMb = run.result?.rssGrowthMb ?? 0
      // The decode is deterministic and the shared host's noise only adds, so an over-budget run gets two more tries.
      for (let retry = 0; retry < CHAT_RETRIES && control && !run.died; retry++) {
        if (cpuMs <= control.cpuMs + CHAT_CPU_MS && rssGrowthMb <= control.rssGrowthMb + CHAT_RSS_MB)
          break
        run = await runScene(image.id, 'chat', index)
        if (run.died) break
        cpuMs = Math.min(cpuMs, run.result?.cpuMs ?? cpuMs)
        rssGrowthMb = Math.min(rssGrowthMb, run.result?.rssGrowthMb ?? rssGrowthMb)
      }
      console.log(
        [
          image.id.padEnd(30),
          run.exit.padEnd(16),
          run.result ? `cpu ${cpuMs.toFixed(0)} ms  rss peak +${rssGrowthMb.toFixed(0)} MB` : 'no result',
          run.abort ? `ABORT: ${run.abort}` : '',
          `wall ${Math.round(run.wallMs)} ms`
        ].join('  ')
      )
      const cpuOverMs = control && run.result ? cpuMs - control.cpuMs : null
      const rssOverMb = control && run.result ? rssGrowthMb - control.rssGrowthMb : null
      if (!isControl)
        chatRows.push({
          id: image.id,
          cpuOverMs,
          rssOverMb,
          ok:
            !run.died &&
            cpuOverMs !== null &&
            rssOverMb !== null &&
            cpuOverMs <= CHAT_CPU_MS &&
            rssOverMb <= CHAT_RSS_MB
        })
      if (run.died) failures.push(run.died)
      else if (isControl)
        control = {
          cpuMs: Math.max(control?.cpuMs ?? 0, cpuMs),
          rssGrowthMb: Math.max(control?.rssGrowthMb ?? 0, rssGrowthMb)
        }
      else if (!control) failures.push(`${image.id}: no control measurement`)
      else {
        if (cpuMs > control.cpuMs + CHAT_CPU_MS)
          failures.push(`${image.id}: ${(cpuMs - control.cpuMs).toFixed(0)} ms CPU over the control`)
        if (rssGrowthMb > control.rssGrowthMb + CHAT_RSS_MB)
          failures.push(
            `${image.id}: resident memory peaked ${(rssGrowthMb - control.rssGrowthMb).toFixed(0)} MB over the control`
          )
      }
    }
  }
  if (mode === 'chat') writeFileSync(path.join(out, 'chat.json'), JSON.stringify(chatRows, null, 2))
  for (const [index, attack] of SVG_ATTACKS.entries()) {
    if (mode === 'chat') break
    if (only && !only.has(attack.id)) continue
    const run = await runScene(attack.id, mode === 'raw' ? 'raw' : 'one', index)
    const { result } = run
    const line = [
      attack.id.padEnd(26),
      run.exit.padEnd(16),
      result
        ? `decode min ${result.setImageMs?.toFixed(1) ?? '-'} max ${result.setImageMaxMs?.toFixed(1) ?? '-'} ms`
        : 'no result',
      result?.stats
        ? `frame max ${result.stats.maxMs?.toFixed(1) ?? '-'} ms over ${result.stats.frames}`
        : '',
      result?.setImageError ? `(${result.setImageError.slice(0, 60)})` : '',
      run.abort ? `ABORT: ${run.abort}` : '',
      `wall ${Math.round(run.wallMs)} ms`
    ].join('  ')
    console.log(line)
    if (mode === 'raw') continue
    if (run.died || !result) failures.push(run.died ?? `${attack.id}: no result`)
    else {
      if ((result.setImageMs ?? 0) > BUDGET_MS)
        failures.push(`${attack.id}: native decode ${result.setImageMs?.toFixed(1)} ms`)
      if ((result.stats?.maxMs ?? 0) > HANG_MS)
        failures.push(`${attack.id}: frame ${result.stats?.maxMs?.toFixed(1)} ms`)
    }
  }

  if (mode === 'app' && !values['no-grid']) await grid()
} finally {
  xvfb.stop()
  rmSync(ATTACK_FIFO, { force: true })
}

async function grid(): Promise<void> {
  const file = path.join(out, 'grid.json')
  const shot = path.join(out, 'grid.png')
  if (existsSync(file)) unlinkSync(file)
  const scene = Bun.spawn(['bun', sceneFile, file, 'grid'], {
    env,
    stdout: 'ignore',
    stderr: 'pipe'
  })
  try {
    const deadline = Date.now() + SCENE_TIMEOUT_MS
    while (!existsSync(file)) {
      if (scene.exitCode !== null)
        throw new Error(
          `grid scene exited ${scene.exitCode}: ${(await new Response(scene.stderr).text()).slice(-400)}`
        )
      if (Date.now() > deadline) throw new Error('grid scene never wrote its ready file')
      await Bun.sleep(50)
    }
    await Bun.sleep(500)
    const origin = await windowOrigin(xvfb.display, GRID_WIDTH, GRID_HEIGHT)
    await grabFrame(xvfb.display, GRID_WIDTH, GRID_HEIGHT, shot, origin)
    await Bun.sleep(1500)
    if (scene.exitCode !== null)
      failures.push(`grid scene died after painting (exit ${scene.exitCode})`)
  } finally {
    scene.kill()
    await scene.exited
  }
  const { bounds } = JSON.parse(readFileSync(file, 'utf8')) as {
    bounds: Record<string, { x: number; y: number; width: number; height: number } | null>
  }
  const png = PNG.sync.read(readFileSync(shot))
  const tile = (key: string): number[] | null => {
    const b = bounds[key]
    if (!b) return null
    const values: number[] = []
    for (let y = Math.round(b.y); y < Math.round(b.y + b.height); y++)
      for (let x = Math.round(b.x); x < Math.round(b.x + b.width); x++) {
        const i = (y * png.width + x) * 4
        values.push((png.data[i] ?? 0) + (png.data[i + 1] ?? 0) + (png.data[i + 2] ?? 0))
      }
    return values
  }
  let worst = 0
  for (const icon of bundledIcons()) {
    const now = tile(`app:${icon.name}`)
    const before = tile(`legacy:${icon.name}`)
    if (!now || !before) {
      failures.push(`${icon.name}: no tile bounds`)
      continue
    }
    const ink = now.filter((v) => v > 96).length
    const differ = now.filter((v, i) => Math.abs(v - (before[i] ?? 0)) > 48).length
    worst = Math.max(worst, differ)
    if (ink === 0) failures.push(`${icon.name}: paints nothing`)
    if (differ > 0) failures.push(`${icon.name}: ${differ} px differ from G16`)
    console.log(
      `icon ${icon.name.padEnd(34)} ink ${String(ink).padStart(4)} px  differs from G16 ${differ} px`
    )
  }
  console.log(`grid: ${shot} (${bundledIcons().length} icons, worst diff ${worst} px)`)
}

if (failures.length) {
  console.error(`FAIL ${failures.length}:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(mode === 'raw' ? 'raw run reported' : 'PASS')
