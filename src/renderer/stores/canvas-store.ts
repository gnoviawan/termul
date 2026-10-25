/**
 * Canvas store — one figcraft mount per project (AD-7, AD-19).
 *
 * A session's `phase` is the mount state machine:
 * `opening` (facade open in flight) → `loading` (iframe navigating, bridge
 * attached; on `event.ready` the pin is checked and the document loaded) →
 * `ready` (document loaded, theme and locale sent), `failed` (mount
 * refused, load failed or editor crashed) or `unloaded` (no mount: the host
 * evicted it to stay under `canvas.max_mounted` (AD-26), or an open was
 * refused because the canvas that had to make room could not be saved). The host allocates `mountSeq` on
 * every open and never reuses it, so a remount cannot accept the previous
 * iframe's messages.
 *
 * Persistence is the host's (AD-23): this store holds only the projection
 * `{dirty, contentVersion, savedVersion, saving, saveError}`. It forwards
 * `event.dirtyChanged` to the facade, which answers once the host's debounce
 * settles; when the host says a save is due, or the user saves, it runs
 * `host.snapshot` → facade write → `host.markSaved`.
 *
 * The host ranks eviction by activity, so a visible `CanvasPanel` reports
 * itself through `setCanvasVisible`; a report the host answers
 * `CANVAS_CLOSED` means the mount is gone and the session becomes
 * `unloaded`.
 *
 * A mount outlives its tab (AD-19): closing the tab only hides the iframe
 * (`CanvasMountLayer` keeps it offscreen), so agent calls still reach it and
 * reopening the tab shows the same mount. A session ends only through
 * `unmountCanvas`, which asks the host to run the AD-31 sequence (quiesce,
 * save, verify, unmount) and drops the session once the host unmounted.
 *
 * The host leases each project's canvas to one window (AD-30). When another
 * window opens it, the host saves and unmounts this window's mount and the
 * session moves to `elsewhere`; opening it again here takes it back the same
 * way.
 *
 * Disk changes are detected by Termul, never by the editor (AD-27): the
 * file watcher reports the document changed (`checkDisk`), the host compares
 * the file with what Termul last read or wrote, and a clean editor reloads
 * silently while a dirty one gets `conflict` and the panel's choice
 * (`resolveConflict`). A crashed editor (`event.crashed`, or timeouts the
 * host counted) is replaced by a fresh mount loading the last saved bytes
 * (`applyRemount`), and `crash` tells the panel what was lost.
 *
 * Bridges live in a module-level map, not in reactive state: they are
 * imperative controllers that `CanvasShell` attaches and detaches with the
 * iframe. Logs never carry the `ct` token or document content.
 */

import type {
  CanvasCloseOutcome,
  CanvasConflict,
  CanvasConflictChoice,
  CanvasErrorCode,
  CanvasLeaseLoss,
  CanvasOpenInfo,
  CanvasPersistenceView,
  CanvasRemount
} from '@shared/types/canvas.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { toast } from 'sonner'
import { create } from 'zustand'
import { canvasApi } from '@/lib/canvas-api'
import {
  asJsonText,
  bridgeFailure,
  type CanvasBridge,
  type CanvasBridgeEvent,
  type CanvasBridgeReply,
  type JsonText
} from '@/lib/canvas-bridge'
import { canvasDocFile, sameCanvasDoc } from '@/lib/canvas-doc'
import { readCanvasThemeTokens } from '@/lib/canvas-theme'
import { logFrontendError } from '@/lib/log-api'
import { basename } from '@/lib/path-basename'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export interface CanvasMount {
  mountSeq: number
  info: CanvasOpenInfo
}

export type CanvasPhase =
  | { kind: 'opening' }
  | { kind: 'loading'; mount: CanvasMount }
  | { kind: 'ready'; mount: CanvasMount }
  /** `mountSeq` is the host mount the failure left behind, `null` when the
   * host holds none for this window. */
  | { kind: 'failed'; code: CanvasErrorCode; message: string; mountSeq: number | null }
  /** Another window took the canvas's lease; this one's mount was saved and
   * unmounted. Opening the canvas again takes it back. */
  | { kind: 'elsewhere' }
  | { kind: 'unloaded'; reason: UnloadReason; message: string | null }

/** `evicted`: unloaded to save memory. `blocked`: an open was refused
 * because the canvas that had to make room could not be saved. */
export type UnloadReason = 'evicted' | 'blocked'

export interface CanvasSession {
  projectId: string
  docPath: string
  phase: CanvasPhase
  dirty: boolean
  /** The engine's u64 content version, kept as decimal text. */
  contentVersion: string | null
  /** The version last written to disk; `null` until the file exists. */
  savedVersion: string | null
  saving: boolean
  saveError: string | null
  /** The host is running the unmount sequence for this mount. */
  closing: boolean
  /** AD-27: the file changed on disk while the editor held unsaved work. */
  conflict: CanvasConflict | null
  /** A conflict choice is being carried out. */
  resolving: boolean
  /** The crash remount this mount came from, shown until dismissed. */
  crash: CanvasRemount | null
}

export interface CanvasState {
  sessions: Record<string, CanvasSession>
  /** True when the project has a canvas session afterwards; false on a typed
   * failure (callers fall back); 'superseded' when a newer open or close
   * took over the project while this one was in flight. `showTab: false`
   * mounts without opening or focusing the canvas tab. */
  openCanvas: (
    projectId: string,
    docPath: string,
    options?: { showTab?: boolean }
  ) => Promise<boolean | 'superseded'>
  /** Unmount through the host's AD-31 sequence; the session ends only when
   * the host unmounted. `discard` is the user's choice to drop unsaved
   * changes after a failed save. */
  unmountCanvas: (projectId: string, discard?: boolean) => Promise<IpcResult<CanvasCloseOutcome>>
  /** This window no longer holds the project's mount: another window took
   * it (`elsewhere`), the mount cap unloaded it (`evicted`), or the host
   * dropped it after the connection was gone longer than the lease grace
   * (`expired`). */
  leaseLost: (projectId: string, mountSeq: number, loss: CanvasLeaseLoss) => void
  /** The host no longer holds this project's mount: drop the editor and show
   * the unloaded state. */
  markUnloaded: (
    projectId: string,
    reason: UnloadReason,
    message?: string,
    docPath?: string
  ) => void
  /** Tell the host the user started or stopped looking at the canvas. */
  setCanvasVisible: (projectId: string, mountSeq: number, visible: boolean) => Promise<void>
  attachBridge: (projectId: string, mountSeq: number, bridge: CanvasBridge) => void
  detachBridge: (projectId: string, bridge: CanvasBridge) => void
  handleBridgeEvent: (projectId: string, mountSeq: number, event: CanvasBridgeEvent) => void
  /** Forward one control-protocol call to the project's editor; `deadline`
   * drops it unrun if it is still queued for a loading editor then. */
  callCanvas: (
    projectId: string,
    method: string,
    params?: JsonText,
    deadline?: number
  ) => Promise<CanvasBridgeReply>
  /** User Save: snapshot and write now, regardless of the debounce. True
   * when the file on disk holds this snapshot or a newer one. */
  saveCanvas: (projectId: string) => Promise<boolean>
  pushTheme: (projectId: string) => void
  pushLocale: (projectId: string) => void
  /** Termul's file watcher saw the project's document change. */
  checkDisk: (projectId: string) => Promise<void>
  /** Carry out the user's answer to a conflict. True when it is resolved. */
  resolveConflict: (projectId: string, choice: CanvasConflictChoice) => Promise<boolean>
  /** The host replaced `remount.previousMountSeq` with a fresh mount. False
   * when this renderer does not hold that mount. */
  applyRemount: (projectId: string, remount: CanvasRemount) => boolean
  dismissCrash: (projectId: string) => void
}

const bridges = new Map<string, { mountSeq: number; bridge: CanvasBridge }>()
/** Dirty notifications forwarded per project; a retry runs only while no
 * newer one went out. */
const dirtyNotices = new Map<string, number>()
const lifecycleGenerations = new Map<string, number>()
const savesInFlight = new Map<string, number>()

const CLEAN_PROJECTION = {
  dirty: false,
  contentVersion: null,
  savedVersion: null,
  saving: false,
  saveError: null,
  closing: false,
  conflict: null,
  resolving: false,
  crash: null
} as const satisfies Partial<CanvasSession>

function nextLifecycleGeneration(projectId: string): number {
  const next = (lifecycleGenerations.get(projectId) ?? 0) + 1
  lifecycleGenerations.set(projectId, next)
  return next
}

function isStaleLifecycle(projectId: string, generation: number): boolean {
  return lifecycleGenerations.get(projectId) !== generation
}

/** The host answered `CANVAS_CLOSED` for a mount this window still showed:
 * it was dropped without this window being told. */
const HOST_DROPPED_PHASE: CanvasPhase = {
  kind: 'failed',
  code: 'CANVAS_CLOSED',
  mountSeq: null,
  message:
    'Termul closed this canvas, so changes made here since were not saved. Open it again to continue from its last save.'
}

/** The phase a session moves to when this window loses its mount. */
const LEASE_LOSS_PHASE: Record<CanvasLeaseLoss, CanvasPhase> = {
  elsewhere: { kind: 'elsewhere' },
  evicted: { kind: 'unloaded', reason: 'evicted', message: null },
  expired: {
    kind: 'failed',
    code: 'CANVAS_CLOSED',
    mountSeq: null,
    message:
      'The canvas closed after this window was disconnected for too long. Open it again to continue from its last save.'
  }
}

function mountOf(phase: CanvasPhase): CanvasMount | null {
  return phase.kind === 'loading' || phase.kind === 'ready' ? phase.mount : null
}

/** The host mount this window holds for the session, if any. */
function hostMountSeq(phase: CanvasPhase): number | null {
  return phase.kind === 'failed' ? phase.mountSeq : (mountOf(phase)?.mountSeq ?? null)
}

function currentBridge(projectId: string, mountSeq: number): CanvasBridge | null {
  const entry = bridges.get(projectId)
  return entry && entry.mountSeq === mountSeq ? entry.bridge : null
}

function projectionOf(view: CanvasPersistenceView): Partial<CanvasSession> {
  return {
    dirty: view.dirty,
    contentVersion: view.contentVersion,
    savedVersion: view.savedVersion,
    saveError: view.saveError,
    conflict: view.conflict ?? null
  }
}

export type PinVerdict = 'match' | 'mismatch-logged' | 'mismatch-refused'

/** AD-22: a bundle whose `host.describe` tag differs from the pin is refused
 * in release builds and only logged in dev, where the bundle is a local
 * build tagged `dev`. */
export function pinVerdict(
  describedTag: string | null,
  pinTag: string,
  release: boolean
): PinVerdict {
  if (describedTag === pinTag) return 'match'
  return release ? 'mismatch-refused' : 'mismatch-logged'
}

function describedTag(reply: CanvasBridgeReply): string | null {
  if (!reply.ok) return null
  try {
    const tag = (JSON.parse(reply.result) as { tag?: unknown } | null)?.tag
    return typeof tag === 'string' ? tag : null
  } catch {
    return null
  }
}

function logCanvas(level: 'info' | 'warn', source: string, message: string): void {
  void logFrontendError({ level, source: `canvas-store.${source}`, message })
}

export const useCanvasStore = create<CanvasState>((set, get) => {
  const patchSession = (projectId: string, patch: Partial<CanvasSession>): void => {
    set((state) => {
      const existing = state.sessions[projectId]
      if (!existing) return {}
      return { sessions: { ...state.sessions, [projectId]: { ...existing, ...patch } } }
    })
  }

  const phaseMountSeq = (projectId: string): number | null => {
    const session = get().sessions[projectId]
    return session ? (mountOf(session.phase)?.mountSeq ?? null) : null
  }

  const isLiveMount = (projectId: string, mountSeq: number): boolean =>
    currentBridge(projectId, mountSeq) !== null && phaseMountSeq(projectId) === mountSeq

  /** Ends this window's hold on the project's mount: in-flight work for it
   * goes stale and its bridge is disposed. */
  const releaseMount = (projectId: string): void => {
    nextLifecycleGeneration(projectId)
    bridges.get(projectId)?.bridge.dispose()
    bridges.delete(projectId)
    savesInFlight.delete(projectId)
  }

  const dropSession = (projectId: string): void => {
    releaseMount(projectId)
    set((state) => {
      const { [projectId]: _closed, ...rest } = state.sessions
      return { sessions: rest }
    })
  }

  /** The host answered `CANVAS_CLOSED` for `mountSeq`: if this window still
   * shows it, say so instead of letting edits go unsaved. */
  const hostDropped = (projectId: string, mountSeq: number): void => {
    if (!isLiveMount(projectId, mountSeq)) return
    logCanvas('warn', 'hostDropped', `the host no longer holds the canvas of project ${projectId}`)
    releaseMount(projectId)
    patchSession(projectId, { phase: HOST_DROPPED_PHASE, ...CLEAN_PROJECTION })
  }

  const failMount = (
    projectId: string,
    mountSeq: number,
    code: CanvasErrorCode,
    message: string
  ): void => {
    bridges.get(projectId)?.bridge.dispose()
    bridges.delete(projectId)
    patchSession(projectId, { phase: { kind: 'failed', code, message, mountSeq } })
  }

  /** AD-31: the document is loaded before anything can be dirty or saved. A
   * missing file is a new document; its first save creates it. */
  const loadDocument = async (
    projectId: string,
    mount: CanvasMount,
    bridge: CanvasBridge
  ): Promise<CanvasPersistenceView | null> => {
    const fail = (message: string): null => {
      logCanvas('warn', 'load', `canvas document load failed for project ${projectId}: ${message}`)
      failMount(
        projectId,
        mount.mountSeq,
        'DOCUMENT_LOAD_FAILED',
        `Could not load the canvas: ${message}`
      )
      return null
    }
    const stale = (): boolean => currentBridge(projectId, mount.mountSeq) !== bridge
    const read = await canvasApi.readDocument(projectId, mount.mountSeq)
    if (stale()) return null
    if (!read.success) return fail(`${read.code} ${read.error}`)
    let ack: string | null = null
    if (read.data.bytes !== null) {
      const opened = await bridge.call(
        'host.openDocument',
        asJsonText(JSON.stringify({ bytes: read.data.bytes }))
      )
      if (stale()) return null
      if (!opened.ok) return fail(`${opened.error.code} ${opened.error.message}`)
      ack = opened.result
    }
    const loaded = await canvasApi.documentLoaded(projectId, mount.mountSeq, ack)
    if (stale()) return null
    if (!loaded.success) return fail(`${loaded.code} ${loaded.error}`)
    return loaded.data
  }

  /** #1421: the editor embeds only Inter, so symbols, CJK and emoji come
   * from the system fonts the desktop lends it. They load before the
   * document, so its first render and an agent's first screenshot have
   * them. A failure costs only those characters, never the mount. */
  const loadFallbackFonts = async (projectId: string, mount: CanvasMount, bridge: CanvasBridge) => {
    const urls = mount.info.fallbackFonts
    if (urls.length === 0) return
    const reply = await bridge.call('host.fallbackFonts', asJsonText(JSON.stringify({ urls })))
    if (!reply.ok) {
      // UNKNOWN_METHOD: a bundle older than `host.fallbackFonts`.
      logCanvas(
        reply.error.code === 'UNKNOWN_METHOD' ? 'info' : 'warn',
        'fonts',
        `fallback fonts not loaded for project ${projectId}: ${reply.error.code} ${reply.error.message}`
      )
      return
    }
    if (!/"failed"\s*:\s*\[\s*\]/.test(reply.result)) {
      logCanvas(
        'warn',
        'fonts',
        `some fallback fonts failed for project ${projectId}: ${reply.result}`
      )
    }
  }

  const completeMount = async (projectId: string, mount: CanvasMount): Promise<void> => {
    const bridge = currentBridge(projectId, mount.mountSeq)
    if (!bridge) return
    const tag = describedTag(await bridge.call('host.describe'))
    if (currentBridge(projectId, mount.mountSeq) !== bridge) return
    const verdict = pinVerdict(tag, mount.info.pinTag, import.meta.env.PROD)
    if (verdict === 'mismatch-refused') {
      logCanvas(
        'warn',
        'mount',
        `refused the canvas mount for project ${projectId}: bundle tag ${tag} does not match the pinned ${mount.info.pinTag}`
      )
      failMount(
        projectId,
        mount.mountSeq,
        'BUNDLE_PIN_MISMATCH',
        `The canvas bundle (${tag ?? 'unknown'}) does not match this build (${mount.info.pinTag}).`
      )
      return
    }
    await loadFallbackFonts(projectId, mount, bridge)
    if (currentBridge(projectId, mount.mountSeq) !== bridge) return
    const view = await loadDocument(projectId, mount, bridge)
    if (view === null) return
    logCanvas(
      verdict === 'match' ? 'info' : 'warn',
      'mount',
      `canvas ready for project ${projectId} mountSeq=${mount.mountSeq} bundle=${tag} pin=${mount.info.pinTag} saved=${view.savedVersion ?? 'new'}`
    )
    patchSession(projectId, { phase: { kind: 'ready', mount }, ...projectionOf(view) })
    get().pushTheme(projectId)
    get().pushLocale(projectId)
    pushFile(projectId)
  }

  const setSaving = (projectId: string, delta: 1 | -1): void => {
    const count = (savesInFlight.get(projectId) ?? 0) + delta
    if (count > 0) savesInFlight.set(projectId, count)
    else savesInFlight.delete(projectId)
    patchSession(projectId, { saving: count > 0 })
  }

  /** `host.snapshot` → host write → `host.markSaved`. The host serializes
   * writes and drops a snapshot older than what it already saved. */
  const runSave = async (projectId: string, mountSeq: number): Promise<boolean> => {
    const bridge = currentBridge(projectId, mountSeq)
    if (!bridge) return false
    const failed = (message: string): false => {
      logCanvas('warn', 'save', `canvas save failed for project ${projectId}: ${message}`)
      if (isLiveMount(projectId, mountSeq)) patchSession(projectId, { saveError: message })
      return false
    }
    setSaving(projectId, 1)
    try {
      const snapshot = await bridge.call('host.snapshot')
      if (!snapshot.ok) return failed(`${snapshot.error.code} ${snapshot.error.message}`)
      const written = await canvasApi.writeSnapshot(projectId, mountSeq, snapshot.result)
      if (!isLiveMount(projectId, mountSeq)) return false
      if (!written.success && written.code === 'CANVAS_CLOSED') {
        hostDropped(projectId, mountSeq)
        return false
      }
      if (!written.success) return failed(`${written.code} ${written.error}`)
      patchSession(projectId, projectionOf(written.data.view))
      const { markSaved } = written.data
      if (markSaved === null) {
        const { saveError, conflict } = written.data.view
        if (conflict) return false
        return saveError ? failed(saveError) : true
      }
      const marked = await bridge.call(
        'host.markSaved',
        asJsonText(`{"contentVersion":${markSaved}}`)
      )
      if (!marked.ok) {
        logCanvas(
          'warn',
          'save',
          `host.markSaved failed for project ${projectId}: ${marked.error.code}`
        )
      }
      return true
    } finally {
      setSaving(projectId, -1)
    }
  }

  /** The host owns the debounce: this resolves once it settles, and a later
   * notification supersedes an earlier one. A notification that did not
   * reach the host shows as a save error and is sent again once, after the
   * autosave delay, unless a newer one went out meanwhile. */
  const forwardDirty = async (
    projectId: string,
    mountSeq: number,
    dirty: boolean,
    contentVersion: string,
    retry = true
  ): Promise<void> => {
    const notice = (dirtyNotices.get(projectId) ?? 0) + 1
    dirtyNotices.set(projectId, notice)
    const result = await canvasApi.dirtyChanged(projectId, mountSeq, dirty, contentVersion)
    if (!isLiveMount(projectId, mountSeq)) return
    if (!result.success && result.code === 'CANVAS_CLOSED') {
      hostDropped(projectId, mountSeq)
      return
    }
    if (!result.success) {
      logCanvas(
        'warn',
        'dirtyChanged',
        `canvas dirty notification failed for project ${projectId}: ${result.code}`
      )
      patchSession(projectId, { saveError: `Autosave could not reach Termul: ${result.error}` })
      if (retry) {
        setTimeout(() => {
          const now = get().sessions[projectId]
          if (dirtyNotices.get(projectId) !== notice || now?.phase.kind !== 'ready') return
          if (now.contentVersion === null) return
          void forwardDirty(projectId, mountSeq, now.dirty, now.contentVersion, false)
        }, useAppSettingsStore.getState().settings.canvasAutosaveMs)
      }
      return
    }
    const outcome = result.data
    if (outcome.kind === 'superseded') return
    patchSession(projectId, projectionOf(outcome.view))
    // A frame that reloaded itself holds no edits until its document is back.
    if (outcome.kind === 'saveDue' && get().sessions[projectId]?.phase.kind === 'ready') {
      await runSave(projectId, mountSeq)
    }
  }

  /** The disk change the host raised as a conflict: shown once. */
  const showConflict = (projectId: string, view: CanvasPersistenceView): void => {
    const session = get().sessions[projectId]
    const hadConflict = session?.conflict != null
    patchSession(projectId, projectionOf(view))
    if (session && view.conflict && !hadConflict) {
      toast.warning(`${basename(session.docPath)} changed on disk`, {
        description: 'The canvas has unsaved changes. Choose which version to keep.'
      })
    }
  }

  /** The editor did not load what the host handed it, so it still holds its
   * old content: the host makes the change on disk a conflict (AD-27). */
  const reloadNotTaken = async (projectId: string, mountSeq: number, why: string) => {
    logCanvas('warn', 'reload', `canvas reload not applied for project ${projectId}: ${why}`)
    const reported = await canvasApi.diskChanged(projectId, mountSeq, true)
    if (isLiveMount(projectId, mountSeq) && reported.success) {
      showConflict(projectId, reported.data.view)
    }
    return false
  }

  /** Load the disk's `bytes` into the mounted editor; the host re-initialises
   * the saved version from the `host.openDocument` ack (AD-31). `cleanAt` is
   * the version the host judged clean: an editor that has moved past it holds
   * edits the reload would drop, so it is not reloaded. */
  const reloadDocument = async (
    projectId: string,
    mountSeq: number,
    bytes: string,
    cleanAt?: string | null
  ): Promise<boolean> => {
    const bridge = currentBridge(projectId, mountSeq)
    if (!bridge) return false
    const now = get().sessions[projectId]
    if (cleanAt !== undefined && (now?.dirty || now?.contentVersion !== cleanAt)) {
      return reloadNotTaken(projectId, mountSeq, 'the editor changed since it was judged clean')
    }
    const opened = await bridge.call('host.openDocument', asJsonText(JSON.stringify({ bytes })))
    if (!isLiveMount(projectId, mountSeq)) return false
    if (!opened.ok) return reloadNotTaken(projectId, mountSeq, opened.error.code)
    const loaded = await canvasApi.documentLoaded(projectId, mountSeq, opened.result)
    if (!isLiveMount(projectId, mountSeq)) return false
    if (!loaded.success) return reloadNotTaken(projectId, mountSeq, loaded.code)
    patchSession(projectId, projectionOf(loaded.data))
    pushFile(projectId)
    return true
  }

  /** `event.crashed`: the host remounts from the last saved bytes. A remount
   * that crashes again before it loaded is not retried. */
  const reportCrash = async (
    projectId: string,
    mountSeq: number,
    reason: string
  ): Promise<void> => {
    logCanvas('warn', 'crashed', `canvas editor crashed for project ${projectId}: ${reason}`)
    const session = get().sessions[projectId]
    const crashedWhileRecovering =
      session?.phase.kind === 'loading' && session.crash?.mountSeq === mountSeq
    const result = crashedWhileRecovering
      ? null
      : await canvasApi.crashed(projectId, mountSeq, reason)
    if (result?.success) {
      get().applyRemount(projectId, result.data)
      return
    }
    if (!isLiveMount(projectId, mountSeq)) return
    failMount(projectId, mountSeq, 'EDITOR_CRASHED', 'The canvas editor stopped working.')
  }

  const sendHostCall = (projectId: string, method: string, params: () => JsonText): void => {
    const session = get().sessions[projectId]
    if (session?.phase.kind !== 'ready') return
    const bridge = currentBridge(projectId, session.phase.mount.mountSeq)
    if (!bridge) return
    let body: JsonText
    try {
      body = params()
    } catch (error) {
      logCanvas('warn', method, `could not build ${method}: ${String(error)}`)
      return
    }
    void bridge.call(method, body).then((reply) => {
      if (!reply.ok) {
        logCanvas('warn', method, `${method} failed for project ${projectId}: ${reply.error.code}`)
      }
    })
  }

  /** The editor knows nothing of the file it shows: without this it names
   * the document by what is stored inside it ("Untitled"). A document load
   * resets it, so it follows every load. */
  const pushFile = (projectId: string): void => {
    sendHostCall(projectId, 'host.file', () => {
      const docPath = get().sessions[projectId]?.docPath ?? ''
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
      return asJsonText(JSON.stringify(canvasDocFile(docPath, project)))
    })
  }

  return {
    sessions: {},

    openCanvas: async (projectId, docPath, options) => {
      if (!projectId || !docPath) return false
      const showTab = (path: string): void => {
        if (options?.showTab !== false) useWorkspaceStore.getState().addCanvasTab(projectId, path)
      }
      const existing = get().sessions[projectId]
      if (existing && sameCanvasDoc(existing.docPath, docPath) && mountOf(existing.phase)) {
        showTab(existing.docPath)
        return true
      }
      if (existing && mountOf(existing.phase)) {
        const closed = await get().unmountCanvas(projectId)
        if (!closed.success) {
          toast.error(`Could not close the open canvas: ${closed.error}`)
          return false
        }
        return get().openCanvas(projectId, docPath, options)
      }
      const generation = nextLifecycleGeneration(projectId)
      const resuming = existing?.phase.kind === 'unloaded'
      if (existing === undefined) {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [projectId]: { projectId, docPath, phase: { kind: 'opening' }, ...CLEAN_PROJECTION }
          }
        }))
      } else if (resuming) {
        patchSession(projectId, { docPath, phase: { kind: 'opening' } })
      }
      const {
        canvasAutosaveMs,
        canvasAutosaveMaxMs,
        canvasLeaseGraceMs,
        canvasMaxMounted,
        canvasCrashTimeouts
      } = useAppSettingsStore.getState().settings
      const result = await canvasApi.open(docPath, projectId, {
        autosaveMs: canvasAutosaveMs,
        autosaveMaxMs: canvasAutosaveMaxMs,
        leaseGraceMs: canvasLeaseGraceMs,
        maxMounted: canvasMaxMounted,
        crashTimeouts: canvasCrashTimeouts
      })
      if (result.success) {
        for (const eviction of result.data.evicted) {
          logCanvas(
            'info',
            'openCanvas',
            `canvas for project ${eviction.projectId} was unloaded: ${eviction.reason}`
          )
          get().markUnloaded(eviction.projectId, 'evicted')
        }
      }
      if (isStaleLifecycle(projectId, generation)) {
        logCanvas('info', 'openCanvas', `dropped a superseded canvas open for project ${projectId}`)
        // Nothing here holds this mount; a newer mount is out of its reach.
        if (result.success) void canvasApi.close(projectId, result.data.mountSeq)
        return 'superseded'
      }
      if (!result.success) {
        logCanvas(
          'warn',
          'openCanvas',
          `canvas open failed for project ${projectId}: ${result.code} ${result.error}`
        )
        toast.error(`Could not open the canvas: ${result.error}`)
        if (result.code === 'EVICTION_BLOCKED') {
          get().markUnloaded(projectId, 'blocked', result.error, docPath)
          showTab(docPath)
        } else if (existing === undefined) {
          set((state) => {
            const { [projectId]: _dropped, ...rest } = state.sessions
            return { sessions: rest }
          })
        } else if (resuming) {
          patchSession(projectId, { phase: existing.phase })
        }
        return false
      }
      const mount: CanvasMount = { mountSeq: result.data.mountSeq, info: result.data }
      set((state) => ({
        sessions: {
          ...state.sessions,
          [projectId]: {
            projectId,
            docPath,
            phase: { kind: 'loading', mount },
            ...CLEAN_PROJECTION
          }
        }
      }))
      showTab(docPath)
      return true
    },

    unmountCanvas: async (projectId, discard = false) => {
      const session = get().sessions[projectId]
      const mountSeq = session ? hostMountSeq(session.phase) : null
      if (!session || mountSeq === null) {
        // This window holds no host mount (another window does, the host
        // dropped it, or an open is still in flight and closes its own).
        if (session) dropSession(projectId)
        return {
          success: true,
          data: { unmounted: false, savedVersion: null, discarded: false }
        }
      }
      patchSession(projectId, { closing: true })
      const result = await canvasApi.close(projectId, mountSeq, discard)
      if (!result.success) {
        logCanvas(
          'warn',
          'unmountCanvas',
          `canvas unmount refused for project ${projectId}: ${result.code} ${result.error}`
        )
        patchSession(projectId, { closing: false })
        return result
      }
      dropSession(projectId)
      logCanvas(
        result.data.discarded ? 'warn' : 'info',
        'unmountCanvas',
        `canvas unmounted for project ${projectId} saved=${result.data.savedVersion ?? 'none'} discarded=${result.data.discarded}`
      )
      return result
    },

    leaseLost: (projectId, mountSeq, loss) => {
      if (phaseMountSeq(projectId) !== mountSeq) return
      releaseMount(projectId)
      patchSession(projectId, { phase: LEASE_LOSS_PHASE[loss], ...CLEAN_PROJECTION })
      logCanvas(
        loss === 'expired' ? 'warn' : 'info',
        'leaseLost',
        `canvas for project ${projectId} mountSeq=${mountSeq} lost its lease: ${loss}`
      )
    },

    markUnloaded: (projectId, reason, message, docPath) => {
      const existing = get().sessions[projectId]
      if (!existing && docPath === undefined) return
      releaseMount(projectId)
      const unloaded: CanvasSession = {
        projectId,
        docPath: docPath ?? existing?.docPath ?? '',
        phase: { kind: 'unloaded', reason, message: message ?? null },
        ...CLEAN_PROJECTION
      }
      set((state) => ({ sessions: { ...state.sessions, [projectId]: unloaded } }))
    },

    setCanvasVisible: async (projectId, mountSeq, visible) => {
      const result = await canvasApi.setVisible(projectId, mountSeq, visible)
      if (result.success || !visible || result.code !== 'CANVAS_CLOSED') return
      if (phaseMountSeq(projectId) !== mountSeq) return
      logCanvas(
        'info',
        'setCanvasVisible',
        `the host no longer holds the canvas of project ${projectId}`
      )
      get().markUnloaded(projectId, 'evicted')
    },

    attachBridge: (projectId, mountSeq, bridge) => {
      const previous = bridges.get(projectId)
      if (previous && previous.bridge !== bridge) previous.bridge.dispose()
      bridges.set(projectId, { mountSeq, bridge })
    },

    detachBridge: (projectId, bridge) => {
      bridge.dispose()
      if (bridges.get(projectId)?.bridge === bridge) bridges.delete(projectId)
    },

    handleBridgeEvent: (projectId, mountSeq, event) => {
      if (!isLiveMount(projectId, mountSeq)) return
      const session = get().sessions[projectId]
      switch (event.method) {
        case 'event.ready':
          if (session?.phase.kind === 'loading') void completeMount(projectId, session.phase.mount)
          if (session?.phase.kind === 'ready') {
            // The frame reloaded itself and shows an empty editor: nothing is
            // saved until the last save is loaded into it again.
            logCanvas('warn', 'ready', `canvas frame reloaded for project ${projectId}`)
            patchSession(projectId, { phase: { kind: 'loading', mount: session.phase.mount } })
            void completeMount(projectId, session.phase.mount)
          }
          return
        case 'event.dirtyChanged':
          // AD-31: dirty state starts once the document is loaded.
          if (session?.phase.kind !== 'ready') return
          patchSession(projectId, { dirty: event.dirty, contentVersion: event.contentVersion })
          void forwardDirty(projectId, mountSeq, event.dirty, event.contentVersion)
          return
        case 'event.crashed':
          void reportCrash(projectId, mountSeq, event.reason)
          return
        default: {
          const unhandled: never = event
          return unhandled
        }
      }
    },

    callCanvas: (projectId, method, params, deadline) => {
      const entry = bridges.get(projectId)
      if (!entry || phaseMountSeq(projectId) !== entry.mountSeq) {
        return Promise.resolve(bridgeFailure('CANVAS_CLOSED', 'no canvas is mounted'))
      }
      return entry.bridge.call(method, params, deadline)
    },

    saveCanvas: async (projectId) => {
      const phase = get().sessions[projectId]?.phase
      if (phase?.kind !== 'ready') return false
      const saved = await runSave(projectId, phase.mount.mountSeq)
      const live = isLiveMount(projectId, phase.mount.mountSeq)
      if (!saved && live && !get().sessions[projectId]?.conflict) {
        toast.error('Could not save the canvas.')
      }
      return saved
    },

    pushTheme: (projectId) => {
      sendHostCall(projectId, 'host.theme', () =>
        asJsonText(JSON.stringify({ tokens: readCanvasThemeTokens() }))
      )
    },

    pushLocale: (projectId) => {
      sendHostCall(projectId, 'host.locale', () =>
        asJsonText(JSON.stringify({ bcp47: navigator.language || 'en-US' }))
      )
    },

    checkDisk: async (projectId) => {
      const session = get().sessions[projectId]
      if (session?.phase.kind !== 'ready') return
      const { mountSeq } = session.phase.mount
      const result = await canvasApi.diskChanged(projectId, mountSeq)
      if (!isLiveMount(projectId, mountSeq)) return
      if (!result.success) {
        logCanvas(
          'warn',
          'checkDisk',
          `canvas disk check failed for project ${projectId}: ${result.code}`
        )
        return
      }
      const outcome = result.data
      if (outcome.kind === 'reload') {
        await reloadDocument(projectId, mountSeq, outcome.bytes, outcome.view.contentVersion)
        return
      }
      showConflict(projectId, outcome.view)
    },

    resolveConflict: async (projectId, choice) => {
      const session = get().sessions[projectId]
      if (session?.phase.kind !== 'ready' || !session.conflict || session.resolving) return false
      const { mountSeq } = session.phase.mount
      const bridge = currentBridge(projectId, mountSeq)
      if (!bridge) return false
      const failed = (message: string): false => {
        logCanvas(
          'warn',
          'resolveConflict',
          `canvas ${choice} failed for project ${projectId}: ${message}`
        )
        toast.error(`Could not resolve the canvas conflict: ${message}`)
        return false
      }
      patchSession(projectId, { resolving: true })
      try {
        let snapshot: string | undefined
        if (choice === 'saveCopy') {
          const taken = await bridge.call('host.snapshot')
          if (!taken.ok) return failed(taken.error.message)
          snapshot = taken.result
        }
        const result = await canvasApi.resolveConflict(projectId, mountSeq, choice, snapshot)
        if (!isLiveMount(projectId, mountSeq)) return false
        if (!result.success) return failed(result.error)
        patchSession(projectId, projectionOf(result.data.view))
        const { reload, copyPath } = result.data
        if (copyPath) toast.success(`Saved your version as ${basename(copyPath)}`)
        if (reload !== null) return await reloadDocument(projectId, mountSeq, reload)
        return await runSave(projectId, mountSeq)
      } finally {
        patchSession(projectId, { resolving: false })
      }
    },

    applyRemount: (projectId, remount) => {
      const session = get().sessions[projectId]
      const held = session ? mountOf(session.phase) : null
      if (!held || held.mountSeq !== remount.previousMountSeq) return false
      bridges.get(projectId)?.bridge.dispose()
      bridges.delete(projectId)
      savesInFlight.delete(projectId)
      const mount: CanvasMount = {
        mountSeq: remount.mountSeq,
        info: { ...held.info, mountSeq: remount.mountSeq }
      }
      patchSession(projectId, {
        phase: { kind: 'loading', mount },
        ...CLEAN_PROJECTION,
        crash: remount
      })
      logCanvas(
        'warn',
        'remount',
        `canvas remounted for project ${projectId} mountSeq ${remount.previousMountSeq}->${remount.mountSeq}: ${remount.reason}`
      )
      return true
    },

    dismissCrash: (projectId) => patchSession(projectId, { crash: null })
  }
})

if (import.meta.env.DEV && typeof window !== 'undefined') {
  // Dev builds only: lets Playwright/CDP drive a mounted editor through the
  // real bridge until the MCP gateway (E3) is the caller.
  Object.assign(window, {
    __termulCanvasCall: (projectId: string, method: string, params?: string) =>
      useCanvasStore
        .getState()
        .callCanvas(projectId, method, params === undefined ? undefined : asJsonText(params))
  })
}

export function useCanvasSession(projectId: string | null): CanvasSession | null {
  return useCanvasStore((state) => (projectId ? (state.sessions[projectId] ?? null) : null))
}
