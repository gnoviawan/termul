import { useCallback, useEffect, useState } from 'react'
import type { MentionMatch } from '@/components/chat/mention-menu-model'
import {
  loadMentionRecents,
  pushRecent as pushRecentPure,
  saveMentionRecents
} from '@/lib/acp-mention-recents-persistence'

/**
 * Recently-@-mentioned files for the active `(projectId, cwd)`, partitioned per
 * ADR 0002/0003. Loads on mount; `pushRecent` updates state + persists.
 */
export function useMentionRecents(
  projectId: string | undefined,
  cwd: string | undefined
): { recents: MentionMatch[]; pushRecent: (match: MentionMatch) => void } {
  const [recents, setRecents] = useState<MentionMatch[]>([])

  useEffect(() => {
    if (!projectId || !cwd) {
      setRecents([])
      return
    }
    let cancelled = false
    void (async () => {
      const loaded = await loadMentionRecents(projectId, cwd)
      if (!cancelled) setRecents(loaded)
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, cwd])

  const pushRecent = useCallback(
    (match: MentionMatch) => {
      const pid = projectId
      const dir = cwd
      setRecents((prev) => {
        const next = pushRecentPure(prev, match)
        if (pid && dir) void saveMentionRecents(pid, dir, next).catch(() => {})
        return next
      })
    },
    [projectId, cwd]
  )

  return { recents, pushRecent }
}
