/**
 * Canvas store (OpenPencil canvas mode) — runtime state per open canvas.
 *
 * One canvas per project (AD-7): `sessions` is keyed by projectId; the
 * workspace-store's `addCanvasTab` owns the singleton tab + doc re-binding,
 * this store owns the daemon/bridge runtime: open (facade open → MCP entry
 * upsert → focus tab), close (facade close evicts the daemon — daemon
 * lifetime = canvas lifetime), save (facade save through the daemon, THEN
 * the bridge's `save-committed` ack with the last generation/revision the
 * editor reported), and theme/locale pushes.
 *
 * The bridge instances themselves live in a module-level map (never in
 * reactive state): they are imperative controllers, and the panel attaches /
 * detaches them as the iframe mounts / re-navigates. Boundary logging goes
 * through `logFrontendError` with dotted `canvas-store.*` sources; document
 * contents and tokens are never logged.
 */

import type { CanvasOpenInfo } from '@shared/types/canvas.types'
import { toast } from 'sonner'
import { create } from 'zustand'
import { canvasApi } from '@/lib/canvas-api'
import type {
  BridgeColorScheme,
  BridgeConflictMode,
  CanvasBridgeController,
  CanvasBridgeEvent
} from '@/lib/canvas-bridge'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export type CanvasSessionStatus = 'opening' | 'open' | 'error'

export interface CanvasSession {
  projectId: string
  docPath: string
  docKey: string
  embedUrl: string
  /** Stable Termul-proxied MCP endpoint (passed to `op-bridge/init`). */
  mcpUrl?: string
  /** Web-only canvas session token (the bridge init token). Never logged. */
  bridgeToken?: string
  status: CanvasSessionStatus
  /** Typed failure code when `status === 'error'`. */
  errorCode?: string
  bridgeReady: boolean
  dirty: boolean
  /** Last (generation, revision) the editor reported via `ready` /
   * `dirty-changed` — echoed back on `save-committed`. */
  generation: number
  revision: number
  saving: boolean
  conflict: { serverVersion: number } | null
}

export interface CanvasState {
  sessions: Record<string, CanvasSession>

  /** Open (or re-bind) the project's canvas. Resolves true when the session
   * is open after the call; false on a typed failure (callers fall back to
   * the text-editor flow). */
  openCanvas: (projectId: string, docPath: string) => Promise<boolean>
  closeCanvas: (projectId: string) => Promise<void>
  saveCanvas: (projectId: string) => Promise<void>
  resolveConflict: (projectId: string, mode: BridgeConflictMode) => void
  /** Dismiss the conflict prompt without resolving (the editor stays
   * conflicted; a later `sync-conflict` re-prompts). */
  dismissConflict: (projectId: string) => void
  handleBridgeEvent: (projectId: string, event: CanvasBridgeEvent) => void
  /** The bridge's init retry budget was exhausted without the editor
   * reaching `listening`/`ready` — surface a failure state (a later `ready`
   * flips the session back to `open`). */
  handleInitFailed: (projectId: string) => void
  attachBridge: (projectId: string, bridge: CanvasBridgeController) => void
  detachBridge: (projectId: string, bridge: CanvasBridgeController) => void
  pushTheme: (projectId: string, colorScheme: BridgeColorScheme) => void
  pushLocale: (projectId: string, locale: string) => void
}

/** Bridge instances per project (imperative controllers, not reactive state). */
const bridges = new Map<string, CanvasBridgeController>()

/** Host-generated request ids for the resolve-conflict round trip (the
 * editor echoes them back on `conflict-resolved`). */
let conflictRequestCounter = 0

function sessionFromOpen(info: CanvasOpenInfo, projectId: string, docPath: string): CanvasSession {
  return {
    projectId,
    docPath,
    docKey: info.docKey,
    embedUrl: info.embedUrl,
    mcpUrl: info.mcpUrl ?? undefined,
    bridgeToken: info.canvasToken,
    status: 'open',
    bridgeReady: false,
    dirty: false,
    generation: 0,
    revision: 0,
    saving: false,
    conflict: null
  }
}

function patchSession(
  state: CanvasState,
  projectId: string,
  patch: Partial<CanvasSession>
): Partial<CanvasState> {
  const existing = state.sessions[projectId]
  if (!existing) return {}
  return { sessions: { ...state.sessions, [projectId]: { ...existing, ...patch } } }
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  sessions: {},

  /** Resolves true when the project has an open canvas session after the
   * call (callers fall back to the text-editor flow on a typed failure). */
  openCanvas: async (projectId: string, docPath: string): Promise<boolean> => {
    if (!projectId || !docPath) return false
    const existing = get().sessions[projectId]
    if (existing === undefined) {
      set({
        sessions: {
          ...get().sessions,
          [projectId]: {
            projectId,
            docPath,
            docKey: '',
            embedUrl: '',
            status: 'opening',
            bridgeReady: false,
            dirty: false,
            generation: 0,
            revision: 0,
            saving: false,
            conflict: null
          }
        }
      })
    }
    const result = await canvasApi.open(docPath, projectId)
    if (!result.success) {
      void logFrontendError({
        level: 'warn',
        source: 'canvas-store.openCanvas',
        message: `canvas open failed for project ${projectId}: ${result.code} ${result.error}`
      })
      toast.error(`Could not open the canvas: ${result.error}`)
      // Doc-switch failure keeps the old session + tab intact; a
      // first-open failure leaves no session (no tab was created).
      if (existing === undefined) {
        const next = { ...get().sessions }
        delete next[projectId]
        set({ sessions: next })
      }
      return false
    }
    // The bridge runtime resets only when the embed URL actually changes
    // (doc re-bind, web token rotation) — the panel then remounts the iframe
    // and attaches a fresh bridge. A repeat open resolving to the SAME embed
    // URL (desktop, same doc → same daemon) keeps the live bridge and its
    // dirty/ready state; only the refreshable fields (docKey, mcpUrl) update.
    const sameRuntime =
      existing !== undefined &&
      existing.status === 'open' &&
      existing.docPath === docPath &&
      existing.embedUrl === result.data.embedUrl
    if (!sameRuntime) {
      bridges.get(projectId)?.dispose()
      bridges.delete(projectId)
    }
    set((state) => ({
      sessions: {
        ...state.sessions,
        [projectId]:
          sameRuntime && existing
            ? {
                ...existing,
                docKey: result.data.docKey,
                embedUrl: result.data.embedUrl,
                mcpUrl: result.data.mcpUrl ?? undefined,
                bridgeToken: result.data.canvasToken
              }
            : sessionFromOpen(result.data, projectId, docPath)
      }
    }))
    // Doc re-bind: the NEW open succeeded, so evict the OLD doc's daemon
    // (best-effort — a failed old-doc close is logged but never fails the
    // new open; the pool releases it on the next open/close/app exit).
    if (existing !== undefined && existing.status === 'open' && existing.docPath !== docPath) {
      const closeResult = await canvasApi.close(existing.docPath)
      if (!closeResult?.success) {
        void logFrontendError({
          level: 'warn',
          source: 'canvas-store.openCanvas',
          message: `old-doc canvas close failed during doc re-bind for project ${projectId}: ${closeResult.code} ${closeResult.error}`
        })
      }
    }
    if (result.data.mcpUrl) {
      try {
        // canvasToken: web → the canvas session token, desktop → the managed
        // token (the agentation MCP routes now require it as the bearer).
        // The mcp slice picks the credential per surface; never logged.
        await useAcpStore
          .getState()
          .upsertCanvasMcpServer(projectId, result.data.mcpUrl, result.data.canvasToken)
      } catch (err) {
        void logFrontendError({
          level: 'warn',
          source: 'canvas-store.openCanvas',
          message: `canvas MCP entry upsert failed for project ${projectId} (${String(err)})`
        })
      }
    } else {
      void logFrontendError({
        level: 'info',
        source: 'canvas-store.openCanvas',
        message: `canvas open without an MCP url (agentation unavailable); skipping MCP upsert for project ${projectId}`
      })
    }
    useWorkspaceStore.getState().addCanvasTab(projectId, docPath)
    return true
  },

  closeCanvas: async (projectId: string): Promise<void> => {
    const session = get().sessions[projectId]
    if (!session) return
    bridges.get(projectId)?.dispose()
    bridges.delete(projectId)
    const next = { ...get().sessions }
    delete next[projectId]
    set({ sessions: next })
    const result = await canvasApi.close(session.docPath)
    if (!result.success) {
      void logFrontendError({
        level: 'warn',
        source: 'canvas-store.closeCanvas',
        message: `canvas close failed for project ${projectId}: ${result.code} ${result.error}`
      })
    }
  },

  saveCanvas: async (projectId: string): Promise<void> => {
    const session = get().sessions[projectId]
    if (!session || session.saving) return
    // The save's identity: the doc it was issued against. If a doc re-bind
    // completes while the save is in flight, the ack below must NOT fire
    // against the NEW editor with the OLD doc's generation/revision.
    const savedDocKey = session.docKey
    set((state) => patchSession(state, projectId, { saving: true }))
    const result = await canvasApi.save(session.docPath)
    if (!get().sessions[projectId]) return
    if (!result.success) {
      set((state) => patchSession(state, projectId, { saving: false }))
      void logFrontendError({
        level: 'warn',
        source: 'canvas-store.saveCanvas',
        message: `canvas save failed for project ${projectId}: ${result.code} ${result.error}`
      })
      toast.error(`Could not save the canvas: ${result.error}`)
      return
    }
    set((state) => patchSession(state, projectId, { saving: false }))
    const current = get().sessions[projectId]
    if (!current) return
    if (current.docKey !== savedDocKey) {
      void logFrontendError({
        level: 'info',
        source: 'canvas-store.saveCanvas',
        message: `skipping the save-committed ack for project ${projectId}: the doc re-bound while the save was in flight`
      })
      return
    }
    // The daemon persisted the doc; ack the editor with the last
    // (generation, revision) it reported so it clears its dirty flag.
    const bridge = bridges.get(projectId)
    if (bridge) {
      bridge.sendSaveCommitted(current.generation, current.revision)
    }
  },

  resolveConflict: (projectId: string, mode: BridgeConflictMode): void => {
    const session = get().sessions[projectId]
    if (!session || !session.conflict) return
    const bridge = bridges.get(projectId)
    if (!bridge) {
      set((state) => patchSession(state, projectId, { conflict: null }))
      return
    }
    conflictRequestCounter += 1
    bridge.sendResolveConflict(mode, `canvas-conflict-${conflictRequestCounter}`)
  },

  dismissConflict: (projectId: string): void => {
    set((state) => patchSession(state, projectId, { conflict: null }))
  },

  handleBridgeEvent: (projectId: string, event: CanvasBridgeEvent): void => {
    switch (event.type) {
      case 'listening':
        return
      case 'ready':
        set((state) =>
          patchSession(state, projectId, {
            status: 'open',
            bridgeReady: true,
            generation: event.generation,
            revision: event.revision
          })
        )
        return
      case 'dirty-changed':
        set((state) =>
          patchSession(state, projectId, {
            dirty: event.dirty,
            generation: event.generation,
            revision: event.revision
          })
        )
        return
      case 'sync-conflict':
        set((state) =>
          patchSession(state, projectId, { conflict: { serverVersion: event.serverVersion } })
        )
        return
      case 'conflict-resolved':
        set((state) => patchSession(state, projectId, { conflict: null }))
        return
      default:
        return
    }
  },

  handleInitFailed: (projectId: string): void => {
    set((state) => {
      const existing = state.sessions[projectId]
      if (!existing || existing.bridgeReady) return {}
      return patchSession(state, projectId, {
        status: 'error',
        errorCode: 'BRIDGE_INIT_FAILED'
      })
    })
  },

  attachBridge: (projectId: string, bridge: CanvasBridgeController): void => {
    bridges.get(projectId)?.dispose()
    bridges.set(projectId, bridge)
  },

  detachBridge: (projectId: string, bridge: CanvasBridgeController): void => {
    if (bridges.get(projectId) === bridge) {
      bridge.dispose()
      bridges.delete(projectId)
    }
  },

  pushTheme: (projectId: string, colorScheme: BridgeColorScheme): void => {
    bridges.get(projectId)?.sendTheme(colorScheme)
  },

  pushLocale: (projectId: string, locale: string): void => {
    bridges.get(projectId)?.sendLocale(locale)
  }
}))

/** Select a project's canvas session (null when no canvas is open). */
export function useCanvasSession(projectId: string | null): CanvasSession | null {
  return useCanvasStore((state) => (projectId ? (state.sessions[projectId] ?? null) : null))
}
