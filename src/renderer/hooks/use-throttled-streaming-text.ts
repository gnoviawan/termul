import { useEffect, useRef, useState } from 'react'

/**
 * Minimum spacing between committed streaming-text updates (ms). Streamdown
 * re-parses the full tail markdown whenever its children string changes, so
 * store flushes faster than this window collapse into one 10 Hz commit.
 */
const STREAMING_TEXT_COMMIT_INTERVAL_MS = 100

/**
 * Throttle the text fed to the streaming tail's markdown render.
 *
 * `text` is recomputed on every store flush (up to once per animation frame),
 * and Streamdown re-parses its whole markdown source whenever that string
 * changes — making the live tail the hottest parse in the chat. While
 * `streaming` is true, the last-committed text is held in state and released
 * at most once per `STREAMING_TEXT_COMMIT_INTERVAL_MS`, trailing edge: a
 * change that lands inside the window is committed by a timer at the window
 * boundary carrying the latest text, and the first change after a quiet gap
 * commits immediately so perceived token latency stays live.
 *
 * When `streaming` flips false (turn end, or the message stops being the
 * timeline tail), the incoming text commits during the render itself (a
 * React render-phase state update on our own state), so the settled render
 * is byte-exact with no extra frame and no pending timer. Non-streaming
 * (historical) messages never throttle: every text change is returned
 * as-is.
 *
 * Returns the text to feed the markdown renderer.
 */
export function useThrottledStreamingText(text: string, streaming: boolean): string {
  const [committed, setCommitted] = useState(text)
  /** Wall-clock of the last committed update; null before the first commit. */
  const lastCommitAtRef = useRef<number | null>(null)
  /** Pending trailing-edge timer; canceled on turn end and on unmount. */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Latest `text`, so a scheduled trailing commit carries the freshest value. */
  const latestTextRef = useRef(text)

  // Turn end / non-streaming correction: the exact text must reach the next
  // commit. Setting our own state during render makes React re-render
  // immediately, before committing to the DOM — the final render is exact.
  if (!streaming && committed !== text) {
    setCommitted(text)
  }

  useEffect(() => {
    latestTextRef.current = text
    if (!streaming) {
      // The final text was already committed during render; drop any pending
      // trailing commit and reset the window for a possible re-stream.
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      lastCommitAtRef.current = null
      return
    }
    const now = performance.now()
    const sinceCommit =
      lastCommitAtRef.current === null ? Number.POSITIVE_INFINITY : now - lastCommitAtRef.current
    if (sinceCommit >= STREAMING_TEXT_COMMIT_INTERVAL_MS) {
      // Window elapsed (or the first chunk after a quiet gap): commit now.
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      lastCommitAtRef.current = now
      setCommitted(text)
      return
    }
    // Inside the window: one trailing commit at the boundary is enough.
    if (!timerRef.current) {
      const wait = STREAMING_TEXT_COMMIT_INTERVAL_MS - sinceCommit
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        lastCommitAtRef.current = performance.now()
        setCommitted(latestTextRef.current)
      }, wait)
    }
  }, [text, streaming])

  // Never leave a pending trailing commit behind after unmount.
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    },
    []
  )

  return committed
}
