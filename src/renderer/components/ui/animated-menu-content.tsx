import { motion, useReducedMotion } from 'framer-motion'
import { type ComponentPropsWithoutRef, useState } from 'react'
import { PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type CubicBezier = [number, number, number, number]

/** Fallbacks match `index.css`; jsdom and early paints have no CSS variables. */
const FALLBACK = {
  open: 250,
  close: 150,
  preScale: 0.97,
  closingScale: 0.99,
  ease: [0.22, 1, 0.36, 1] as CubicBezier,
  reducedFade: 150
}

function token(name: string): string {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function msToken(name: string, fallback: number): number {
  const raw = token(name)
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return fallback
  return raw.endsWith('ms') ? value : raw.endsWith('s') ? value * 1000 : value
}

function numberToken(name: string, fallback: number): number {
  const value = Number.parseFloat(token(name))
  return Number.isFinite(value) ? value : fallback
}

function bezierToken(name: string, fallback: CubicBezier): CubicBezier {
  const match = token(name).match(/cubic-bezier\(([^)]+)\)/)
  const parts = match?.[1].split(',').map((p) => Number.parseFloat(p))
  return parts?.length === 4 && parts.every(Number.isFinite) ? (parts as CubicBezier) : fallback
}

/**
 * The transitions.dev "Menu dropdown" motion on the app's motion tokens:
 * open `--duration-fast` from `--scale-medium`, close `--duration-quick` to
 * `--scale-tiny`, both on `--ease-smooth-out`, no travel. Reduced motion is a
 * 150ms fade (the app rule for anchored menus). Values are read from the CSS
 * variables so CSS and JS stay in step.
 */
export function menuMotion(reduced: boolean): {
  initial: { opacity: number; scale?: number }
  open: { opacity: number; scale?: number }
  closed: { opacity: number; scale?: number }
  openTransition: { duration: number; ease: CubicBezier | 'easeOut' }
  closeTransition: { duration: number; ease: CubicBezier | 'easeOut' }
} {
  if (reduced) {
    const fade = { duration: FALLBACK.reducedFade / 1000, ease: 'easeOut' as const }
    return {
      initial: { opacity: 0 },
      open: { opacity: 1 },
      closed: { opacity: 0 },
      openTransition: fade,
      closeTransition: fade
    }
  }
  const ease = bezierToken('--ease-smooth-out', FALLBACK.ease)
  return {
    initial: { opacity: 0, scale: numberToken('--scale-medium', FALLBACK.preScale) },
    open: { opacity: 1, scale: 1 },
    closed: { opacity: 0, scale: numberToken('--scale-tiny', FALLBACK.closingScale) },
    openTransition: { duration: msToken('--duration-fast', FALLBACK.open) / 1000, ease },
    closeTransition: { duration: msToken('--duration-quick', FALLBACK.close) / 1000, ease }
  }
}

/**
 * `PopoverContent` with the shared menu dropdown motion. `className` styles
 * the visible surface. It stays mounted
 * while it closes, so a close that is stopped halfway reverses smoothly, and
 * it grows from the trigger (Radix transform origin). The global Radix
 * keyframes are turned off for it (`termul-popover-transition`).
 */
export function AnimatedMenuContent({
  open,
  className,
  children,
  contentClassName,
  ...props
}: ComponentPropsWithoutRef<typeof PopoverContent> & {
  /** The popover's open state. */
  open: boolean
  /** Classes for the positioned Radix shell (for example a z-index). */
  contentClassName?: string
}): React.JSX.Element | null {
  const reduced = useReducedMotion() ?? false
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  if (!mounted) return null
  const m = menuMotion(reduced)

  return (
    <PopoverContent
      forceMount
      data-menu-motion="dropdown"
      // The Radix element is only a positioned shell; the visible surface
      // (border, fill, shadow) is the animated layer, so it scales and fades
      // as one piece instead of the frame appearing before its content.
      className={cn(
        'termul-popover-transition w-auto border-0 bg-transparent p-0 shadow-none data-[state=closed]:animate-none data-[state=open]:animate-none',
        contentClassName
      )}
      {...props}
    >
      <motion.div
        style={{ transformOrigin: 'var(--radix-popover-content-transform-origin)' }}
        initial={m.initial}
        animate={open ? m.open : m.closed}
        transition={open ? m.openTransition : m.closeTransition}
        onAnimationComplete={() => {
          if (!open) setMounted(false)
        }}
        className={cn(
          'rounded-md border bg-popover text-popover-foreground shadow-md',
          className,
          !open && 'pointer-events-none'
        )}
      >
        {children}
      </motion.div>
    </PopoverContent>
  )
}
