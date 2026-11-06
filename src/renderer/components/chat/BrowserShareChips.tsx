/**
 * Browser tabs shared with this chat, shown in the composer: origin, shared
 * scopes, time left or why sharing ended, and one-action stop. Pending
 * shares go out with the next message as the host's reference block; a sent
 * share stays listed while it is live so the user always sees what the agent
 * can still read.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { browserShareScopeSummary, browserShareStatusLabel } from '@/components/browser/share-copy'
import { Globe, X } from '@/components/icons'
import type { ContentBlock } from '@/lib/acp-api'
import { type BrowserShareView, browserShareBlock } from '@/lib/browser-share-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import {
  retainBrowserShareSync,
  selectSessionShares,
  useBrowserShareStore
} from '@/stores/browser-share-store'

function useSessionShares(sessionId: string): BrowserShareView[] {
  return useBrowserShareStore(useShallow((s) => selectSessionShares(s, sessionId)))
}

/** Re-render at the earliest expiry so the label never shows a stale share as live. */
function useNow(shares: readonly BrowserShareView[]): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const next = shares
      .filter((s) => s.status === 'active' && s.expiresAtMs > now)
      .reduce((min, s) => Math.min(min, s.expiresAtMs), Number.POSITIVE_INFINITY)
    if (!Number.isFinite(next)) return
    const delay = Math.min(next - now, 60_000)
    const timer = setTimeout(() => setNow(Date.now()), Math.max(delay, 250))
    return () => clearTimeout(timer)
  }, [shares, now])
  return now
}

/**
 * Reference blocks for the session's pending, still-live shares, and a
 * callback that marks them sent once the prompt that carries them is out.
 */
export function useBrowserShareAttachments(sessionId: string): {
  blocks: ContentBlock[]
  markSent: () => void
} {
  const shares = useSessionShares(sessionId)
  const pending = useBrowserShareStore((s) => s.pending)
  const markSentInStore = useBrowserShareStore((s) => s.markSent)
  const now = useNow(shares)
  const ready = useMemo(
    () => shares.filter((s) => pending[s.shareId] && s.status === 'active' && s.expiresAtMs > now),
    [shares, pending, now]
  )
  const blocks = useMemo(() => ready.map(browserShareBlock), [ready])
  const markSent = useCallback(
    () => markSentInStore(shares.filter((s) => pending[s.shareId]).map((s) => s.shareId)),
    [markSentInStore, shares, pending]
  )
  return useMemo(() => ({ blocks, markSent }), [blocks, markSent])
}

export function BrowserShareChips({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const enabled = isTauriContext()
  useEffect(() => (enabled ? retainBrowserShareSync() : undefined), [enabled])
  const shares = useSessionShares(sessionId)
  const pending = useBrowserShareStore((s) => s.pending)
  const revoking = useBrowserShareStore((s) => s.revoking)
  const revoke = useBrowserShareStore((s) => s.revoke)
  const [failedId, setFailedId] = useState<string | null>(null)
  const now = useNow(shares)
  if (!enabled || shares.length === 0) return null

  const stop = async (shareId: string): Promise<void> => {
    setFailedId(null)
    if (!(await revoke(shareId))) setFailedId(shareId)
  }

  return (
    <ul
      aria-label="Browser pages shared with this chat"
      className="flex flex-wrap gap-1.5 px-3 pt-3"
    >
      {shares.map((share) => {
        const live = share.status === 'active' && share.expiresAtMs > now
        const state = pending[share.shareId]
          ? live
            ? 'Sends with your message'
            : 'Not sent'
          : 'Shared'
        const status = browserShareStatusLabel(share.status, share.expiresAtMs, now)
        return (
          <li
            key={share.shareId}
            data-browser-share-chip={live ? 'live' : 'ended'}
            className={cn(
              'flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-2xs',
              live ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/40'
            )}
          >
            <Globe
              size={12}
              className={cn('shrink-0', live ? 'text-primary' : 'text-muted-foreground')}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate font-mono text-foreground" title={share.origin}>
              {share.origin}
            </span>
            <span className="min-w-0 truncate text-muted-foreground">
              {browserShareScopeSummary(share.scopes)} · {state} · {status}
              {failedId === share.shareId ? ' · Could not stop. Try again.' : ''}
            </span>
            <button
              type="button"
              onClick={() => void stop(share.shareId)}
              disabled={Boolean(revoking[share.shareId])}
              aria-label={live ? `Stop sharing ${share.origin}` : `Dismiss ${share.origin}`}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              <X size={12} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
