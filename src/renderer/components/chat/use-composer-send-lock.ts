import { useCallback, useState } from 'react'

export interface ComposerSendLock {
  /** True while a send prepares its payload. The composer is read-only meanwhile. */
  locked: boolean
  /** Runs `work` with the composer locked. */
  hold: <T>(work: () => Promise<T>) => Promise<T>
}

/**
 * A send snapshots the draft and attachments, awaits (mentioned chat
 * transcripts, a worktree lookup), then resets the composer. Anything typed or
 * attached during that await would miss the send and then be wiped by the
 * reset, so the composer stays read-only until the payload is built.
 */
export function useComposerSendLock(): ComposerSendLock {
  const [holds, setHolds] = useState(0)
  const hold = useCallback(async <T>(work: () => Promise<T>): Promise<T> => {
    setHolds((n) => n + 1)
    try {
      return await work()
    } finally {
      setHolds((n) => n - 1)
    }
  }, [])
  return { locked: holds > 0, hold }
}
