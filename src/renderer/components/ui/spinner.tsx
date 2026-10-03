import { useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'

/**
 * Comet ring (loading.dev): a full ring that fades into its tail.
 * Inlined here because the loading-dev package requires React 19.
 * One lap is 700ms, linear. Reduced motion pauses the spin.
 */
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
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false

  return (
    <span
      className={cn('tm-comet', className)}
      style={{
        ['--tm-comet-size' as string]: `${size}px`,
        ['--tm-comet-play' as string]: reduced ? 'paused' : 'running'
      }}
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
    >
      <span className="tm-comet-spin">
        <span className="tm-comet-tail" />
        <span className="tm-comet-head" />
      </span>
    </span>
  )
}

export { Spinner }
