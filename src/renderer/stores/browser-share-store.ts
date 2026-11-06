/**
 * Renderer view of the host's "Share to chat" grants (see
 * `lib/browser-share-api.ts`). The host is authoritative: this store only
 * mirrors what the host reports, so a share is shown until the host says it
 * ended or confirms a revoke.
 *
 * A share is `pending` from creation until the next prompt of its session
 * carries its reference. A pending share that ends stays listed with its
 * status so the user sees why it will not be sent; an ended share that was
 * already sent is dropped.
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
  revoking: {},
  consentTabId: null,
  upsert: (view, options) =>
    set((s) => {
      const pending = options?.pending ? { ...s.pending, [view.shareId]: true as const } : s.pending
      if (view.status !== 'active' && !pending[view.shareId]) {
        return {
          shares: without(s.shares, view.shareId),
          revoking: without(s.revoking, view.shareId)
        }
      }
      return { shares: { ...s.shares, [view.shareId]: view }, pending }
    }),
  remove: (shareId) =>
    set((s) => ({
      shares: without(s.shares, shareId),
      pending: without(s.pending, shareId),
      revoking: without(s.revoking, shareId)
    })),
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
