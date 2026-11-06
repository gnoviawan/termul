/**
 * Renderer view of the host's "Share to chat" grants (see
 * `lib/browser-share-api.ts`). The host is authoritative: this store only
 * mirrors what the host reports, so a share is shown until the host says it
 * ended or confirms a revoke.
 *
 * A share is `pending` ("ready to share") until a prompt of its session
 * that carries its reference goes out from this renderer. That includes a
 * live share this renderer first hears of from a host event or the host
 * list (after a reload it cannot know whether one was sent). A pending share
 * that ends stays listed with its status so the user sees why it will not be
 * sent; an ended share that was already sent is dropped.
 *
 * The host may report a share's end before the create reply arrives, so
 * every share id the host reported ended is remembered in `ended`: a later
 * active view of that id (the create reply, a host list) never makes it live
 * again.
 */

import { create } from 'zustand'
import {
  type BrowserShareView,
  browserShareList,
  browserShareRevoke,
  onBrowserShareChanged
} from '@/lib/browser-share-api'
import { logFrontendError } from '@/lib/log-api'

interface BrowserShareState {
  shares: Readonly<Record<string, BrowserShareView>>
  pending: Readonly<Record<string, true>>
  /** The last ended view of every share id that ended, by id. */
  ended: Readonly<Record<string, BrowserShareView>>
  revoking: Readonly<Record<string, true>>
  /** The user tab whose share consent strip is open, if any. */
  consentTabId: string | null
  upsert: (view: BrowserShareView, options?: { pending?: boolean }) => void
  remove: (shareId: string) => void
  markSent: (shareIds: readonly string[]) => void
  openConsent: (tabId: string) => void
  closeConsent: () => void
  revoke: (shareId: string) => Promise<boolean>
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in record)) return record as Record<string, T>
  const { [key]: _gone, ...rest } = record
  return rest
}

export const useBrowserShareStore = create<BrowserShareState>((set, get) => ({
  shares: {},
  pending: {},
  ended: {},
  revoking: {},
  consentTabId: null,
  upsert: (view, options) =>
    set((s) => {
      const id = view.shareId
      const markPending = (): Record<string, true> => ({ ...s.pending, [id]: true })
      if (view.status !== 'active') {
        const ended = { ...s.ended, [id]: view }
        if (s.pending[id] || options?.pending) {
          return { ended, shares: { ...s.shares, [id]: view }, pending: markPending() }
        }
        return { ended, shares: without(s.shares, id), revoking: without(s.revoking, id) }
      }
      const endedView = s.ended[id]
      if (endedView) {
        // A create reply after its end: list it ended, so the user sees why.
        if (!options?.pending || s.shares[id]) return s
        return { shares: { ...s.shares, [id]: endedView }, pending: markPending() }
      }
      const unsent = options?.pending || !(id in s.shares)
      return { shares: { ...s.shares, [id]: view }, pending: unsent ? markPending() : s.pending }
    }),
  remove: (shareId) =>
    set((s) => {
      const view = s.shares[shareId]
      return {
        shares: without(s.shares, shareId),
        pending: without(s.pending, shareId),
        revoking: without(s.revoking, shareId),
        ended: view ? { ...s.ended, [shareId]: { ...view, status: 'revoked' } } : s.ended
      }
    }),
  markSent: (shareIds) =>
    set((s) => {
      let pending = s.pending
      let shares = s.shares
      for (const id of shareIds) {
        pending = without(pending, id)
        if (shares[id] && shares[id].status !== 'active') shares = without(shares, id)
      }
      return pending === s.pending && shares === s.shares ? s : { pending, shares }
    }),
  openConsent: (tabId) => set({ consentTabId: tabId }),
  closeConsent: () => set({ consentTabId: null }),
  revoke: async (shareId) => {
    const view = get().shares[shareId]
    if (!view) return true
    if (view.status !== 'active') {
      get().remove(shareId)
      return true
    }
    set((s) => ({ revoking: { ...s.revoking, [shareId]: true } }))
    const result = await browserShareRevoke(shareId)
    if (result.success || result.code === 'NOT_FOUND') {
      get().remove(shareId)
      void logFrontendError({
        level: 'info',
        message: 'browser share revoked by user',
        source: 'browser-share-store'
      })
      return true
    }
    set((s) => ({ revoking: without(s.revoking, shareId) }))
    void logFrontendError({
      level: 'warn',
      message: `browser share revoke failed: code=${result.code}`,
      source: 'browser-share-store'
    })
    return false
  }
}))

let syncRefs = 0
let stopSync: (() => void) | null = null

/**
 * Keep the store in step with the host while at least one share surface is
 * mounted. Returns the release function.
 */
export function retainBrowserShareSync(): () => void {
  syncRefs += 1
  if (syncRefs === 1) {
    stopSync = onBrowserShareChanged((view) => useBrowserShareStore.getState().upsert(view))
    void browserShareList().then((result) => {
      if (!result.success) {
        if (result.code !== 'UNSUPPORTED' && result.code !== 'UNAVAILABLE') {
          void logFrontendError({
            level: 'warn',
            message: `browser share list failed: code=${result.code}`,
            source: 'browser-share-store'
          })
        }
        return
      }
      const { upsert } = useBrowserShareStore.getState()
      for (const view of result.data) upsert(view)
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    syncRefs -= 1
    if (syncRefs === 0) {
      stopSync?.()
      stopSync = null
    }
  }
}

/** Shares listed in a session's composer: pending ones and live sent ones. */
export function selectSessionShares(
  state: Pick<BrowserShareState, 'shares'>,
  sessionId: string
): BrowserShareView[] {
  return Object.values(state.shares).filter((v) => v.sessionId === sessionId)
}

/** Live shares of one browser tab, for the pane's "shared" indicator. */
export function selectTabActiveShares(
  state: Pick<BrowserShareState, 'shares'>,
  tabId: string
): BrowserShareView[] {
  return Object.values(state.shares).filter((v) => v.tabId === tabId && v.status === 'active')
}
