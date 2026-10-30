import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** Streaming usage reports can arrive many times a second; digits roll at most every 250ms. */
export const ROLLING_THROTTLE_MS = 250

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

/** Leading and trailing throttle: the first change shows at once, the last one always lands. */
export function useThrottledValue<T>(value: T, intervalMs: number = ROLLING_THROTTLE_MS): T {
  const [shown, setShown] = useState(value)
  const lastRef = useRef(0)
  useEffect(() => {
    const wait = lastRef.current + intervalMs - Date.now()
    if (wait <= 0) {
      lastRef.current = Date.now()
      setShown(value)
      return
    }
    const timer = setTimeout(() => {
      lastRef.current = Date.now()
      setShown(value)
    }, wait)
    return () => clearTimeout(timer)
  }, [value, intervalMs])
  return shown
}

/**
 * Text whose digits roll to their new value. Screen readers get the plain
 * text once; the rolling columns are hidden from them.
 */
export function RollingText({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const shown = useThrottledValue(text)
  const chars = Array.from(shown)
  return (
    <span className={cn('tabular-nums', className)}>
      <span className="sr-only">{shown}</span>
      <span aria-hidden="true" className="inline-flex">
        {chars.map((char, index) => {
          // Key from the right so a new leading digit does not reset the others.
          const key = chars.length - index
          if (!DIGITS.includes(char)) {
            return (
              <span key={key} className="whitespace-pre">
                {char}
              </span>
            )
          }
          return (
            <span key={key} className="relative inline-block h-[1lh] overflow-hidden">
              <span
                className="flex flex-col transition-transform duration-[400ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
                style={{ transform: `translateY(-${Number(char) * 10}%)` }}
              >
                {DIGITS.map((digit) => (
                  <span key={digit} className="h-[1lh]">
                    {digit}
                  </span>
                ))}
              </span>
            </span>
          )
        })}
      </span>
    </span>
  )
}
