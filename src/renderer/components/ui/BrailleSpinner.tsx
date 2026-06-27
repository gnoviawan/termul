import { useReducedMotion } from 'framer-motion'
import { useEffect, useState } from 'react'
import spinners, { type BrailleSpinnerName } from 'unicode-animations'

import { cn } from '@/lib/utils'

interface BrailleSpinnerProps {
  name?: BrailleSpinnerName
  className?: string
  'aria-hidden'?: boolean
}

/** Unicode braille frame spinner — see https://github.com/gunnargray-dev/unicode-animations */
export function BrailleSpinner({
  name = 'braille',
  className,
  ...props
}: BrailleSpinnerProps): React.JSX.Element {
  const reducedMotion = useReducedMotion() ?? false
  const [frame, setFrame] = useState(0)
  const { frames, interval } = spinners[name]

  useEffect(() => {
    if (reducedMotion) return
    const timer = setInterval(() => setFrame((f) => (f + 1) % frames.length), interval)
    return () => clearInterval(timer)
  }, [frames.length, interval, reducedMotion])

  const index = reducedMotion ? 0 : frame

  return (
    <span
      className={cn('inline-block w-[1ch] font-mono leading-none tabular-nums', className)}
      {...props}
    >
      {frames[index]}
    </span>
  )
}
