import { cn } from '@/lib/utils'

interface ShimmerTextProps {
  /** Visible label — also mirrored into `data-text` for the CSS highlight layer. */
  text: string
  className?: string
}

/**
 * Loading / in-progress label with a masked gradient sweep (transitions.dev
 * shimmer-text). Pure CSS — toggle by mounting/unmounting this element.
 */
export function ShimmerText({ text, className }: ShimmerTextProps): React.JSX.Element {
  return (
    <span className={cn('t-shimmer', className)} data-text={text}>
      {text}
    </span>
  )
}
