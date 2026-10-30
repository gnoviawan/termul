import type { TerminalModes } from '@shared/types/ipc.types'
import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import { onTerminalModesChanged } from '@/utils/terminal-registry'
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
let unsubscribeModes: (() => void) | undefined
let loading: Promise<void> | undefined
let observedPtyIds = new Map<string, string | undefined>()
const pendingScreenModes = new Map<string, TerminalModes>()
const pendingExits = new Set<string>()

function knownStoreId(id: string): string | undefined {
  const store = terminalStore?.getState()
  if (!store) return undefined
  if (store.terminals.some((terminal) => terminal.id === id)) return id
  return store.findTerminalByPtyId(id)?.id
}

function deliverScreenMode(registryId: string, modes: TerminalModes): void {
  const storeId = knownStoreId(registryId)
  if (!storeId) {
    pendingScreenModes.set(registryId, modes)
    return
  }
  pendingScreenModes.delete(registryId)
  sessionStore.applyScreen(storeId, modes)
}

function flushPendingScreenModes(): void {
  const store = terminalStore?.getState()
  if (!store) return
  for (const [id, modes] of pendingScreenModes) {
    const storeId = knownStoreId(id)
    if (!storeId) continue
    pendingScreenModes.delete(id)
    sessionStore.applyScreen(storeId, modes)
  }
}

function ensureScreenFollower(): void {
  if (unsubscribeModes) return
  unsubscribeModes = onTerminalModesChanged(deliverScreenMode)
}

/** Applies a known restore/replay snapshot. Null modes leave the store unchanged. */
export function publishScreenMode(
  storeId: string | null | undefined,
  modes: TerminalModes | null | undefined
): void {
  if (!storeId || modes == null) return
  deliverScreenMode(storeId, modes)
}

function observeTerminalChanges(store: TerminalStore): void {
  const terminals = store.getState().terminals
  const nextPtyIds = new Map(terminals.map(({ id, ptyId }) => [id, ptyId]))
  const previousPtyIds = observedPtyIds
  observedPtyIds = nextPtyIds

  for (const [id, previousPtyId] of previousPtyIds) {
    if (!nextPtyIds.has(id)) {
      sessionStore.forget(id)
      continue
    }
    const nextPtyId = nextPtyIds.get(id)
    if (previousPtyId !== nextPtyId && (previousPtyId !== undefined || nextPtyId === undefined)) {
      sessionStore.invalidate(id, 'info')
    }
  }
}

function connectTerminalStore(store: TerminalStore): void {
  observedPtyIds = new Map(store.getState().terminals.map(({ id, ptyId }) => [id, ptyId]))
  unsubscribe = store.subscribe(() => {
    observeTerminalChanges(store)
    buffer.flush()
    flushPendingExits()
    flushPendingScreenModes()
  })
  buffer.connect((ptyId) => store.getState().findTerminalByPtyId(ptyId))
  flushPendingExits()
  // Lifecycle replay can reset a snapshot. Apply queued screen state after it.
  flushPendingScreenModes()
}

/** Replays exits once their PTY is mapped to a terminal. */
function flushPendingExits(): void {
  const store = terminalStore?.getState()
  if (!store) return
  for (const ptyId of pendingExits) {
    const terminal = store.findTerminalByPtyId(ptyId)
    if (!terminal) continue
    pendingExits.delete(ptyId)
    sessionStore.processExited(terminal.id)
  }
}

/** Marks the session mapped to an exiting PTY as exited and clears its draft. */
export function forwardSessionExit(ptyId: string): void {
  const terminal = terminalStore?.getState().findTerminalByPtyId(ptyId)
  if (terminal) {
    sessionStore.processExited(terminal.id)
    return
  }

  pendingExits.add(ptyId)
  if (terminalStore) {
    if (!unsubscribe) connectTerminalStore(terminalStore)
    return
  }

  void import('@/stores/terminal-store')
    .then(({ useTerminalStore }) => {
      // A partial test mock, or a module still initializing, has no store.
      // Calling getState would reject this discarded promise.
      if (typeof useTerminalStore?.getState !== 'function') return
      registerSessionTerminalStore(useTerminalStore)
      if (!unsubscribe) connectTerminalStore(useTerminalStore)
    })
    .catch(() => {})
}

export function forwardSessionLifecycle(event: SessionLifecyclePayload): void {
  ensureScreenFollower()
  // Observe rebinds synchronously, including those before an async turn can settle.
  if (!unsubscribe && terminalStore) connectTerminalStore(terminalStore)
  buffer.forward(event)
  if (!unsubscribe && !loading) {
    const pending = import('@/stores/terminal-store')
      .then(({ useTerminalStore }) => {
        if (loading !== pending) return
        // Same guard as exit forwarding: do not register a hook with no getState.
        if (typeof useTerminalStore?.getState !== 'function') return
        registerSessionTerminalStore(useTerminalStore)
        if (!unsubscribe) connectTerminalStore(useTerminalStore)
      })
      .catch(() => {})
    loading = pending
  }
}

/** Releases the terminal-store subscription and buffered events (HMR module swap). */
export function disposeSessionAdapter(): void {
  unsubscribe?.()
  unsubscribe = undefined
  unsubscribeModes?.()
  unsubscribeModes = undefined
  pendingScreenModes.clear()
  pendingExits.clear()
  buffer.dispose()
  observedPtyIds.clear()
  loading = undefined
}

ensureScreenFollower()

// Guarded so production builds and vitest skip it.
if (import.meta.hot) import.meta.hot.dispose(disposeSessionAdapter)
