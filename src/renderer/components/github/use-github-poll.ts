import { useEffect, useRef } from 'react'

/**
 * Call `poll` every `visibleMs` while the document is visible and every
 * `hiddenMs` while it is hidden (`null`: not at all while hidden). A
 * visibility change re-arms the timer with the matching interval. The first
 * call happens one interval after mount; the caller does its own initial load.
 */
export function useGithubPoll(
  poll: () => void,
  visibleMs: number,
  hiddenMs: number | null,
  enabled: boolean
): void {
  const pollRef = useRef(poll)
  pollRef.current = poll

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      clearTimeout(timer)
      const delay = document.visibilityState === 'visible' ? visibleMs : hiddenMs
      if (delay === null) return
      timer = setTimeout(() => {
        pollRef.current()
        arm()
      }, delay)
    }
    arm()
    document.addEventListener('visibilitychange', arm)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', arm)
    }
  }, [visibleMs, hiddenMs, enabled])
}
