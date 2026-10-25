/**
 * The comet ring (web `.tm-comet`): a ring whose alpha climbs from 0 at the
 * top, clockwise, to the full colour, with a round head at the top. GPUIX has
 * no conic gradients, masks or transforms, so the ring is SVG: wedges of
 * rising opacity, rotated by re-rendering the source in 30-degree steps. One
 * lap is 1s; reduced motion holds it at rest, like the paused animation.
 *
 * Each step costs a full GPUIX frame, 15 to 18ms on the UI thread with one
 * chat open, whatever the SVG holds. At the web's 10-degree steps over 700ms
 * (51 frames a second) the spinners alone kept the UI thread at 95% of a
 * core; twelve steps a second, the cadence of a classic activity indicator,
 * cost about a fifth of that.
 */
import { useContext, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { useIconStyle } from '../icons/hugeicons'
import { UiEnvironmentContext } from './internal/host'

const LAP_MS = 1000
const STEP_DEG = 30
const WEDGES = 72

const sources = new Map<string, string>()

/** The ring for diameter `size` (px) rotated by `angle` degrees, painted black. */
export function cometSource(size: number, angle: number): string {
  const key = `${size}:${angle}`
  const cached = sources.get(key)
  if (cached) return cached
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
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g transform="rotate(${angle} ${r} ${r})">${wedges.join('')}${head}</g></svg>`
  sources.set(key, source)
  return source
}

/**
 * One clock for every spinner, so the spinners on screen together (a running
 * chat shows one in its tab and one in its sidebar card) step in one frame
 * instead of one frame each. It ticks only while a spinner is mounted.
 */
const lapClock = (() => {
  const listeners = new Set<() => void>()
  let angle = 0
  let timer: ReturnType<typeof setInterval> | null = null
  const tick = () => {
    const turn = (Date.now() % LAP_MS) / LAP_MS
    const next = Math.floor((turn * 360) / STEP_DEG) * STEP_DEG
    if (next === angle) return
    angle = next
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      timer ??= setInterval(tick, LAP_MS / (360 / STEP_DEG))
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
    },
    angle: () => angle
  }
})()

const atRest = () => () => {}

function useLapAngle(running: boolean): number {
  const angle = useSyncExternalStore(running ? lapClock.subscribe : atRest, lapClock.angle)
  return running ? angle : 0
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
  const angle = useLapAngle(!reducedMotion)
  const style = useIconStyle(size, cn('shrink-0', className), undefined, undefined)
  return (
    <svg
      source={cometSource(size, angle)}
      style={style}
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : label}
    />
  )
}

export { Spinner }
