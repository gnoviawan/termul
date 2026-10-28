import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import { LifecycleBuffer } from './session-buffer'
import { sessionStore } from './session-store'

type TerminalStore = typeof import('@/stores/terminal-store').useTerminalStore
let terminalStore: TerminalStore | undefined

/** Supplies synchronous binding queries without a terminal-store import cycle. */
export function registerSessionTerminalStore(store: TerminalStore): void {
  terminalStore = store
}

// Every fallback scans fresh; only the outermost call drains the shared queue.
let fallbackCandidates: string[] | undefined
const fallbackQueued = new Set<string>()

function invalidateUnboundEditors(): void {
  const nested = fallbackCandidates !== undefined
  fallbackCandidates ??= []
  try {
    for (const { id, ptyId } of terminalStore?.getState().terminals ?? []) {
      const snapshot = sessionStore.read(id)
      if (!ptyId && snapshot.trusted && snapshot.mode === 'Editor' && !fallbackQueued.has(id)) {
        fallbackQueued.add(id)
        fallbackCandidates.push(id)
      }
    }
    if (nested) return
    while (fallbackCandidates.length) {
      // Keep the id deduplicated after dequeue; listeners may rebind queued candidates.
      const id = fallbackCandidates.shift()
      if (id !== undefined) sessionStore.invalidate(id, 'info')
    }
  } finally {
    if (!nested) {
      fallbackCandidates = undefined
      fallbackQueued.clear()
    }
  }
}

const buffer = new LifecycleBuffer(
  (id, event) => sessionStore.apply(id, event),
  (id) => sessionStore.invalidate(id),
  invalidateUnboundEditors
)
let unsubscribe: (() => void) | undefined
let loading: Promise<void> | undefined

function connectTerminalStore(store: TerminalStore): void {
  unsubscribe = store.subscribe(() => buffer.flush())
  buffer.connect((ptyId) => store.getState().findTerminalByPtyId(ptyId))
}

export function forwardSessionLifecycle(event: SessionLifecyclePayload): void {
  // Observe rebinds synchronously, including those before an async turn can settle.
  if (!unsubscribe && terminalStore) connectTerminalStore(terminalStore)
  buffer.forward(event)
  if (!unsubscribe && !loading) {
    const pending = import('@/stores/terminal-store').then(({ useTerminalStore }) => {
      if (loading !== pending) return
      registerSessionTerminalStore(useTerminalStore)
      if (!unsubscribe) connectTerminalStore(useTerminalStore)
    })
    loading = pending
  }
}

/** Releases the terminal-store subscription and buffered events (HMR module swap). */
export function disposeSessionAdapter(): void {
  unsubscribe?.()
  unsubscribe = undefined
  buffer.dispose()
  loading = undefined
}

// Guarded so production builds and vitest skip it.
if (import.meta.hot) import.meta.hot.dispose(disposeSessionAdapter)
