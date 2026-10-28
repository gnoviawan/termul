/**
 * The window `svg-attack-check.ts` drives. Modes:
 *
 *   one <i>   attack i the way the app meets it: a persisted icon run through
 *             the dompurify stand-in and the shared normaliser into an icon
 *             tile, and the raw markup set on a second tile. Times the native
 *             decode of what compat handed the renderer (`setImage`, the
 *             `<img>` path's raster on the UI thread) and the frames after.
 *   raw <i>   attack i straight to a GPUIX `<img>` and `<svg source>`, no
 *             compat in between: what the native renderer does on its own.
 *   grid      every bundled agent icon through the app path, the same icons
 *             through G16's pipeline (`legacyInnerHtmlSvg`), and every attack.
 *   chat <i>  `CHAT_IMAGES[i]` as an agent reply's markdown image: a `data:`
 *             URL in a 384 px `<img>`, decoded off the UI thread. Reports the
 *             CPU time the process spends while it settles and how far its
 *             resident memory peaks over where it started.
 *
 * bun tools/compat/svg-attack-scene.tsx <result.json> <mode> [i]
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { type ImgInstance, type PublicInstance, render, useGpuixRequired } from '@gpuix/react'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import { jsx as nativeJsx } from 'react/jsx-runtime'
import { normalizeRootIconSvg } from '@/lib/agents/sanitize-agent-icon'
import { jsx } from '../../src/compat/jsx-runtime'
import DOMPurify from '../../src/compat/shims/dompurify'
import { innerHtmlSvg } from '../../src/compat/svg'
import {
  bundledIcons,
  GRID_HEIGHT,
  GRID_WIDTH,
  legacyInnerHtmlSvg,
  TILE
} from './svg-attack-shared'
import { CHAT_IMAGES } from './image-attacks'
import { SVG_ATTACKS } from './svg-attacks'

const [resultFile, mode = 'grid', indexArg = '0'] = process.argv.slice(2)
const SETTLE_MS = 1500
/** The decode is deterministic work; the fastest of a few runs drops scheduler noise from the shared host. */
const DECODE_RUNS = 5

interface Stats {
  maxMs?: number
  frames: number
}
interface LiveRenderer {
  setImage(id: number, bytes: Buffer): void
  getElementBounds(id: number): { x: number; y: number; width: number; height: number } | null
  setDebugFrameOverlay?(mode: string): string
  resetDebugFrameOverlayStats?(): void
  getDebugFrameOverlayStats?(): Stats
}

/** The app's path for a stored icon: `sanitizeInlineAgentSvg` with the stand-in, into AcpAgentsSettings' tile. */
function appHtml(markup: string): string {
  return normalizeRootIconSvg(DOMPurify.sanitize(markup, { USE_PROFILES: { svg: true } }))
}

function tile(html: string, key: string): ReactElement {
  return jsx(
    'span',
    {
      className: 'inline-flex shrink-0 [&_svg]:h-full [&_svg]:w-full',
      style: { width: TILE, height: TILE, color: '#ffffff' },
      dangerouslySetInnerHTML: { __html: html }
    },
    key
  )
}

/** The bytes compat hands the native renderer for `html`, at the tile's size. */
function nativeBytes(html: string): Buffer | null {
  const element = innerHtmlSvg(html)
  if (!element) return null
  const props = element.props as { src?: string; native?: { source?: string } }
  if (props.src) return Buffer.from(decodeURIComponent(props.src.slice(props.src.indexOf(',') + 1)))
  const source = props.native?.source
  if (!source) return null
  // The `<svg>` element rasterises its alpha mask at its layout box, not the intrinsic size.
  return Buffer.from(
    source.replace(/^<svg\b[^>]*>/, (tag) =>
      tag
        .replace(/\s(?:width|height)="[^"]*"/g, '')
        .replace('<svg', `<svg width="${TILE}" height="${TILE}"`)
    )
  )
}

function Timed({ children, measure }: { children: ReactElement[]; measure: Buffer | null }) {
  const renderer = useGpuixRequired() as unknown as LiveRenderer
  const probe = useRef<ImgInstance | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    renderer.setDebugFrameOverlay?.('minimal')
    let setImageMs: number | null = null
    let setImageMaxMs: number | null = null
    let setImageError: string | null = null
    if (measure && probe.current) {
      for (let run = 0; run < DECODE_RUNS; run++) {
        const start = performance.now()
        try {
          renderer.setImage(probe.current.id, measure)
        } catch (error) {
          setImageError = String(error)
        }
        const ms = performance.now() - start
        setImageMs = Math.min(setImageMs ?? ms, ms)
        setImageMaxMs = Math.max(setImageMaxMs ?? ms, ms)
      }
    }
    renderer.resetDebugFrameOverlayStats?.()
    const pump = setInterval(() => setTick((t) => t + 1), 16)
    const startedAt = performance.now()
    const done = setTimeout(() => {
      clearInterval(pump)
      const stats = renderer.getDebugFrameOverlayStats?.() ?? null
      writeFileSync(
        `${resultFile}.tmp`,
        JSON.stringify({
          alive: true,
          setImageMs,
          setImageMaxMs,
          setImageError,
          bytes: measure?.length ?? 0,
          elapsedMs: performance.now() - startedAt,
          stats
        })
      )
      renameSync(`${resultFile}.tmp`, resultFile as string)
      process.exit(0)
    }, SETTLE_MS)
    return () => {
      clearInterval(pump)
      clearTimeout(done)
    }
  }, [renderer, measure])
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        backgroundColor: '#08090a',
        flexDirection: 'row',
        gap: 8,
        padding: 8
      }}
    >
      {children}
      <img alt="" ref={probe} src="" style={{ width: 1, height: 1 }} />
      <text style={{ color: '#ffffff', fontSize: 12 }}>{`frame ${tick}`}</text>
    </div>
  )
}

function rawTiles(markup: string): ReactElement[] {
  return [
    nativeJsx('img', {
      key: 'img',
      src: `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`,
      style: { width: TILE, height: TILE }
    }),
    nativeJsx('svg', {
      key: 'svg',
      source: markup,
      style: { width: TILE, height: TILE, color: '#ffffff' }
    })
  ]
}

function Grid() {
  const renderer = useGpuixRequired() as unknown as LiveRenderer
  const refs = useRef(new Map<string, PublicInstance | null>())
  const icons = bundledIcons()
  useEffect(() => {
    const timer = setTimeout(() => {
      const bounds = Object.fromEntries(
        [...refs.current].map(([key, node]) => [
          key,
          node ? renderer.getElementBounds(node.id) : null
        ])
      )
      writeFileSync(`${resultFile}.tmp`, JSON.stringify({ alive: true, pid: process.pid, bounds }))
      renameSync(`${resultFile}.tmp`, resultFile as string)
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [renderer])
  const cell = (key: string, child: ReactElement | null) => (
    <div
      key={key}
      ref={(node: PublicInstance | null) => {
        refs.current.set(key, node)
      }}
      style={{ width: TILE, height: TILE }}
    >
      {child}
    </div>
  )
  const row = (cells: ReactElement[]) => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        width: GRID_WIDTH - 16
      }}
    >
      {cells}
    </div>
  )
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        backgroundColor: '#08090a',
        flexDirection: 'column',
        gap: 16,
        padding: 8
      }}
    >
      {row(icons.map((icon) => cell(`app:${icon.name}`, tile(appHtml(icon.svg), icon.name))))}
      {row(icons.map((icon) => cell(`legacy:${icon.name}`, legacyInnerHtmlSvg(icon.legacyHtml))))}
      {row(
        SVG_ATTACKS.map((attack) => cell(`attack:${attack.id}`, tile(attack.markup, attack.id)))
      )}
    </div>
  )
}

/** Long enough for a budgeted decode to finish; an unbudgeted one is still burning. */
const CHAT_SETTLE_MS = 4000
const CHAT_BOX = 384

/** Resident bytes now, from the kernel: decodes run on native threads the JS heap never sees. */
function residentBytes(): number {
  const pages = Number(readFileSync('/proc/self/statm', 'utf8').split(' ')[1])
  return pages * 4096
}

function ChatImage({ src }: { src: string }) {
  useEffect(() => {
    const before = process.resourceUsage()
    const baseRss = residentBytes()
    let peakRss = baseRss
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, residentBytes())
    }, 20)
    const done = setTimeout(() => {
      clearInterval(sample)
      const after = process.resourceUsage()
      writeFileSync(
        `${resultFile}.tmp`,
        JSON.stringify({
          alive: true,
          cpuMs:
            (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) /
            1000,
          rssGrowthMb: (peakRss - baseRss) / 2 ** 20,
          bytes: src.length,
          stats: null
        })
      )
      renameSync(`${resultFile}.tmp`, resultFile as string)
      process.exit(0)
    }, CHAT_SETTLE_MS)
    return () => {
      clearInterval(sample)
      clearTimeout(done)
    }
  }, [])
  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: '#08090a' }}>
      <img alt="" src={src} objectFit="contain" style={{ width: CHAT_BOX, height: CHAT_BOX }} />
    </div>
  )
}

async function scene(): Promise<ReactElement> {
  if (mode === 'grid') return <Grid />
  if (mode === 'chat') {
    const image = CHAT_IMAGES[Number(indexArg)]
    if (!image) throw new Error(`no chat image ${indexArg}`)
    return <ChatImage src={await image.dataUrl()} />
  }
  const attack = SVG_ATTACKS[Number(indexArg)]
  if (!attack) throw new Error(`no attack ${indexArg}`)
  if (mode === 'raw')
    return <Timed measure={Buffer.from(attack.markup)}>{rawTiles(attack.markup)}</Timed>
  const html = appHtml(attack.markup)
  return (
    <Timed measure={nativeBytes(html) ?? nativeBytes(attack.markup)}>
      {[tile(html, 'app'), tile(attack.markup, 'direct')]}
    </Timed>
  )
}

if (resultFile) {
  render(await scene(), {
    title: 'termul-svg-attack',
    width: mode === 'grid' ? GRID_WIDTH : mode === 'chat' ? 480 : 320,
    height: mode === 'grid' ? GRID_HEIGHT : mode === 'chat' ? 400 : 80,
    focus: false
  })
}
