import { useEffect, useRef, useState } from 'react'

export interface OptimisticSelectState<A = never> {
  /** Value shown on the chip (optimistic while pending, else committed). */
  displayValue: string | undefined
  /** True while the latest in-flight selection has not settled. */
  pending: boolean
  /**
   * Begin an optimistic selection. No-ops when `valueId` matches the current
   * display value and there is no `extra` for it. Soft-replaces: a newer call
   * invalidates older settlements.
   */
  select: (valueId: string, extra?: A) => void
}

/**
 * Optimistic label + pending generation for ACP config/mode/model chips.
 * Keeps the chosen value visible while `onSelect` awaits, reverts on reject,
 * and ignores stale completions when the user soft-replaces mid-flight.
 */
export function useOptimisticSelect<A = never>(
  committedValue: string | undefined,
  onSelect: (valueId: string, extra?: A) => void | Promise<void>
): OptimisticSelectState<A> {
  const [optimisticValue, setOptimisticValue] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const generationRef = useRef(0)

  useEffect(() => {
    if (optimisticValue != null && committedValue === optimisticValue) {
      setOptimisticValue(null)
    }
  }, [committedValue, optimisticValue])

  const displayValue = optimisticValue ?? committedValue

  const select = (valueId: string, extra?: A): void => {
    if (valueId === displayValue && extra === undefined) return

    const generation = generationRef.current + 1
    generationRef.current = generation
    setOptimisticValue(valueId)
    setPending(true)

    // Invoke onSelect synchronously so callers observe the call immediately,
    // but route sync throws through the same rejection path as async failures.
    // (`Promise.resolve(onSelect(...))` would leave the chip pending forever
    // when onSelect throws before the promise is created.)
    let result: void | Promise<void>
    try {
      result = extra === undefined ? onSelect(valueId) : onSelect(valueId, extra)
    } catch {
      if (generationRef.current !== generation) return
      setPending(false)
      setOptimisticValue(null)
      return
    }

    void Promise.resolve(result).then(
      () => {
        if (generationRef.current !== generation) return
        setPending(false)
      },
      () => {
        if (generationRef.current !== generation) return
        setPending(false)
        setOptimisticValue(null)
      }
    )
  }

  return { displayValue, pending, select }
}
