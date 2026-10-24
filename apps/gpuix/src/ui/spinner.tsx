/**
 * The comet ring (web `.tm-comet`): a ring whose alpha climbs from 0 at the
 * top, clockwise, to the full colour, with a round head at the top. GPUIX has
 * no conic gradients, masks or transforms, so the ring is SVG: wedges of
 * rising opacity, rotated by swapping frames in 10-degree steps. One lap is
 * 700ms; reduced motion holds it at rest, like the paused animation.
 *
 * A frame is about 11 KB of SVG at 16 px, and a step that resends it as
 * `source` made spinners 98.5% of the mutation stream under the 8-chat
 * stream-storm (tools/perf/hidden-panes.md). With a frame store installed
 * (`internal/frame-store.ts`), each frame is written to a file once and a
 * step sends its path as `src`. One clock steps every spinner, so all of them
 * change in one batch and wake the window once per step.
 */
import type { PublicInstance } from '@gpuix/react'
import { type RefObject, useContext, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { isOffFrame } from '../compat/visibility'
import { useIconStyle } from '../icons/hugeicons'
import { frameStore } from './internal/frame-store'
import { UiEnvironmentContext } from './internal/host'

const LAP_MS = 700
const STEP_DEG = 10
const WEDGES = 72

/** The ring for diameter `size` (px) rotated by `angle` degrees, painted black. */
export function cometSource(size: number, angle: number): string {
  const r = size / 2
  const stroke = size * 0.12
  const inner = r - stroke
  const polar = (radius: number, deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180
    return `${(r + radius * Math.cos(rad)).toFixed(3)} ${(r + radius * Math.sin(rad)).toFixed(3)}`
  }
  const step = 360 / WEDGES
  const wedges: string[] = []
  for (let i = 0; i < WEDGES; i++) {
    // Overlap each wedge into the next so antialiased seams do not show.
    const from = i * step
    const to = Math.min(360, from + step + 0.6)
    const alpha = ((i + 0.5) / WEDGES).toFixed(3)
    wedges.push(
      `<path fill="#000" fill-opacity="${alpha}" d="M ${polar(r, from)} A ${r} ${r} 0 0 1 ${polar(r, to)} L ${polar(inner, to)} A ${inner} ${inner} 0 0 0 ${polar(inner, from)} Z"/>`
    )
  }
  const head = `<circle fill="#000" cx="${r}" cy="${stroke / 2}" r="${stroke / 2}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g transform="rotate(${angle} ${r} ${r})">${wedges.join('')}${head}</g></svg>`
}

const frames = new Map<string, { src: string }>()

/** FNV-1a, so a frame file is named by its content and a stale one is never read. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(36)
}

/** The svg props for one frame: its file when a store is installed, else the markup. */
export function cometFrame(size: number, angle: number): { src: string } | { source: string } {
  const store = frameStore()
  if (!store) return { source: cometSource(size, angle) }
  const key = `${size}:${angle}`
  const known = frames.get(key)
  if (known) return known
  const svg = cometSource(size, angle)
  const frame = { src: store(`${size}-${angle}-${contentHash(svg)}.svg`, svg) }
  frames.set(key, frame)
  return frame
}

const STEPS = 360 / STEP_DEG
const steppers = new Set<(step: number) => void>()
let clock: ReturnType<typeof setInterval> | null = null

function onStep(stepper: (step: number) => void): () => void {
  steppers.add(stepper)
  clock ??= setInterval(() => {
    const step = Math.floor(((Date.now() % LAP_MS) / LAP_MS) * STEPS)
    for (const each of steppers) each(step)
  }, LAP_MS / STEPS)
  return () => {
    steppers.delete(stepper)
    if (steppers.size > 0 || clock === null) return
    clearInterval(clock)
    clock = null
  }
}

function useLapAngle(running: boolean, ref: RefObject<PublicInstance | null>): number {
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (!running) return
    return onStep((next) => {
      // A browser does not paint a hidden pane's animation; a parked pane is never drawn.
      const id = ref.current?.id
      if (id !== undefined && isOffFrame(id)) return
      setStep(next)
    })
  }, [running, ref])
  return step * STEP_DEG
}

function Spinner({
  className,
  size = 16,
  decorative = false,
  label = 'Loading'
}: {
  className?: string
  /** Diameter in pixels. */
  size?: number
  /** Hide from the accessibility tree when nearby text already names the wait. */
  decorative?: boolean
  /** Accessible name when the spinner is the only status for this wait. */
  label?: string
}) {
  const { reducedMotion } = useContext(UiEnvironmentContext)
  const ref = useRef<PublicInstance | null>(null)
  const angle = useLapAngle(!reducedMotion, ref)
  const style = useIconStyle(size, cn('shrink-0', className), undefined, undefined)
  return (
    <svg
      ref={ref}
      {...cometFrame(size, angle)}
      style={style}
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : label}
    />
  )
}

export { Spinner }
