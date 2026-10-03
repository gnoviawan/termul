/**
 * Canvas store tests (OpenPencil canvas mode, task 22).
 *
 * Drives the open / close / save / conflict flows against a mocked canvas
 * facade + MCP upsert, using the REAL workspace-store so the singleton tab
 * wiring (session → tab → focus) is exercised end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { open, close, save, upsertCanvasMcpServer, toastError, logFrontendError } = vi.hoisted(
  () => ({
    open: vi.fn(),
    close: vi.fn(),
    save: vi.fn(),
    upsertCanvasMcpServer: vi.fn(async () => {}),
    toastError: vi.fn(),
    logFrontendError: vi.fn()
  })
)

vi.mock('@/lib/canvas-api', () => ({
  canvasApi: { open, close, save, status: vi.fn() }
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: { getState: () => ({ upsertCanvasMcpServer }) }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError
}))

vi.mock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

import type { CanvasOpenInfo } from '@shared/types/canvas.types'
import type { IpcResult } from '@shared/types/ipc.types'
import type { CanvasBridgeController } from '@/lib/canvas-bridge'
import type { LeafNode } from '@/types/workspace.types'
import { useCanvasStore } from '../canvas-store'
import { useWorkspaceStore } from '../workspace-store'

const PROJECT = 'proj-1'
const DOC_A = 'C:/proj/design.op'
const DOC_B = 'C:/proj/poster.op'

const MCP_URL = 'http://127.0.0.1:5199/canvas/mcp'

function openInfo(
  embedUrl: string,
  docKey: string,
  canvasToken: string | undefined = 'managed-t0k'
): IpcResult<CanvasOpenInfo> {
  return {
    success: true,
    data: {
      embedUrl,
      mcpUrl: MCP_URL,
      docKey,
      canvasId: undefined,
      canvasToken
    }
  }
}

function failure(code: string): IpcResult<CanvasOpenInfo> {
  return { success: false, error: `canvas failed: ${code}`, code }
}

function fakeBridge(): CanvasBridgeController {
  return {
    sendTheme: vi.fn(),
    sendLocale: vi.fn(),
    sendSaveCommitted: vi.fn(),
    sendResolveConflict: vi.fn(),
    dispose: vi.fn()
  }
}

function activeLeafTabs(): LeafNode['tabs'] {
  const state = useWorkspaceStore.getState()
  const pane = state.root
  return pane.type === 'leaf' ? pane.tabs : []
}

function resetStores(): void {
  useCanvasStore.setState({ sessions: {} })
  useWorkspaceStore.setState(() => {
    const root: LeafNode = { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null }
    return {
      root,
      activePaneId: 'pane-root',
      fullscreenPaneId: null,
      agentLauncherPaneId: null
    }
  })
}

describe('canvas-store open flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStores()
  })

  afterEach(() => {
    resetStores()
  })

  it('open success records the session, upserts the MCP entry, and adds the canvas tab', async () => {
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))

    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    const session = useCanvasStore.getState().sessions[PROJECT]
    expect(session).toMatchObject({
      projectId: PROJECT,
      docPath: DOC_A,
      docKey: DOC_A,
      embedUrl: 'http://127.0.0.1:5199/?embed=vscode',
      status: 'open',
      mcpUrl: MCP_URL,
      bridgeReady: false,
      dirty: false
    })
    expect(upsertCanvasMcpServer).toHaveBeenCalledWith(PROJECT, MCP_URL, 'managed-t0k')
    const canvasTabs = activeLeafTabs().filter((t) => t.type === 'canvas')
    expect(canvasTabs).toHaveLength(1)
    expect(canvasTabs[0]).toMatchObject({
      id: `canvas-${PROJECT}`,
      projectId: PROJECT,
      docPath: DOC_A
    })
    const leaf = useWorkspaceStore.getState().root as LeafNode
    expect(leaf.activeTabId).toBe(`canvas-${PROJECT}`)
  })

  it('repeat open (same doc) refreshes the session and keeps exactly one focused tab', async () => {
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    open.mockResolvedValueOnce(
      openInfo('http://127.0.0.1:5200/?embed=vscode', DOC_A) /* token/URL rotation */
    )
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    expect(open).toHaveBeenCalledTimes(2)
    expect(activeLeafTabs().filter((t) => t.type === 'canvas')).toHaveLength(1)
    expect(useCanvasStore.getState().sessions[PROJECT]?.embedUrl).toBe(
      'http://127.0.0.1:5200/?embed=vscode'
    )
  })

  it('opening a different doc re-binds the singleton tab and evicts the old doc daemon', async () => {
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5201/?embed=vscode', DOC_B))
    close.mockResolvedValueOnce({ success: true, data: true })

    await useCanvasStore.getState().openCanvas(PROJECT, DOC_B)

    // The OLD doc's daemon is evicted only after the NEW open succeeded.
    expect(close).toHaveBeenCalledWith(DOC_A)
    const canvasTabs = activeLeafTabs().filter((t) => t.type === 'canvas')
    expect(canvasTabs).toHaveLength(1)
    expect(canvasTabs[0]).toMatchObject({ docPath: DOC_B })
    expect(useCanvasStore.getState().sessions[PROJECT]).toMatchObject({
      docPath: DOC_B,
      docKey: DOC_B,
      embedUrl: 'http://127.0.0.1:5201/?embed=vscode'
    })
  })

  it('a doc re-bind whose old-doc close fails still completes the new open (best-effort evict)', async () => {
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5201/?embed=vscode', DOC_B))
    close.mockResolvedValueOnce({ success: false, error: 'canvas closed', code: 'CANVAS_CLOSED' })

    const opened = await useCanvasStore.getState().openCanvas(PROJECT, DOC_B)

    expect(opened).toBe(true)
    expect(useCanvasStore.getState().sessions[PROJECT]?.docPath).toBe(DOC_B)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'canvas-store.openCanvas',
        message: expect.stringContaining('old-doc canvas close failed')
      })
    )
  })

  it('open failure leaves no session, no tab, and no MCP upsert', async () => {
    open.mockResolvedValueOnce(failure('BINARY_NOT_FOUND'))

    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    expect(useCanvasStore.getState().sessions[PROJECT]).toBeUndefined()
    expect(upsertCanvasMcpServer).not.toHaveBeenCalled()
    expect(activeLeafTabs().filter((t) => t.type === 'canvas')).toHaveLength(0)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'canvas-store.openCanvas',
        message: expect.stringContaining('BINARY_NOT_FOUND')
      })
    )
    expect(toastError).toHaveBeenCalled()
  })

  it('a doc-switch failure keeps the previous session intact (no old-doc evict)', async () => {
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    open.mockResolvedValueOnce(failure('HANDSHAKE_TIMEOUT'))

    const opened = await useCanvasStore.getState().openCanvas(PROJECT, DOC_B)

    expect(opened).toBe(false)
    // The NEW open failed, so the OLD doc's daemon must NOT be evicted.
    expect(close).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().sessions[PROJECT]).toMatchObject({
      docPath: DOC_A,
      embedUrl: 'http://127.0.0.1:5199/?embed=vscode'
    })
    expect(activeLeafTabs().filter((t) => t.type === 'canvas')).toHaveLength(1)
  })

  it('skips the MCP upsert (and logs info) when the open response has no mcpUrl', async () => {
    open.mockResolvedValueOnce({
      success: true,
      data: {
        embedUrl: 'http://127.0.0.1:5199/?embed=vscode',
        mcpUrl: null,
        docKey: DOC_A
      }
    })

    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    expect(upsertCanvasMcpServer).not.toHaveBeenCalled()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', source: 'canvas-store.openCanvas' })
    )
  })

  it('a close landing while an open is in flight aborts the late open (no session, no tab, no upsert)', async () => {
    let resolveOpen: (value: ReturnType<typeof openInfo>) => void = () => {}
    open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        })
    )
    const opening = useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    // The user closes the canvas while the open is still in flight.
    close.mockResolvedValueOnce({ success: true, data: true })
    await useCanvasStore.getState().closeCanvas(PROJECT)
    expect(useCanvasStore.getState().sessions[PROJECT]).toBeUndefined()

    resolveOpen(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
    await opening

    // The late open applies NOTHING: no restored session, no re-added tab,
    // no MCP upsert.
    expect(useCanvasStore.getState().sessions[PROJECT]).toBeUndefined()
    expect(upsertCanvasMcpServer).not.toHaveBeenCalled()
    expect(activeLeafTabs().filter((t) => t.type === 'canvas')).toHaveLength(0)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'canvas-store.openCanvas',
        message: expect.stringContaining('stale canvas open')
      })
    )
  })

  it('a slow docA open resolving after a newer docB open applies nothing and does NOT evict docB', async () => {
    let resolveDocA: (value: ReturnType<typeof openInfo>) => void = () => {}
    open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDocA = resolve
        })
    )
    const openDocA = useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    // A newer open for the same project completes first.
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5201/?embed=vscode', DOC_B))
    const openedDocB = await useCanvasStore.getState().openCanvas(PROJECT, DOC_B)
    expect(openedDocB).toBe(true)
    expect(useCanvasStore.getState().sessions[PROJECT]).toMatchObject({
      docPath: DOC_B,
      embedUrl: 'http://127.0.0.1:5201/?embed=vscode'
    })

    // docA's result lands late: it must apply nothing — in particular its
    // old-doc cleanup must not evict docB's daemon.
    resolveDocA(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
    await openDocA

    expect(useCanvasStore.getState().sessions[PROJECT]).toMatchObject({
      docPath: DOC_B,
      embedUrl: 'http://127.0.0.1:5201/?embed=vscode'
    })
    const canvasTabs = activeLeafTabs().filter((t) => t.type === 'canvas')
    expect(canvasTabs).toHaveLength(1)
    expect(canvasTabs[0]).toMatchObject({ docPath: DOC_B })
    expect(close).not.toHaveBeenCalled()
    expect(upsertCanvasMcpServer).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'canvas-store.openCanvas',
        message: expect.stringContaining('stale canvas open')
      })
    )
  })
})

describe('canvas-store close flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStores()
  })

  afterEach(() => {
    resetStores()
  })

  it('close evicts the session and calls the facade with the current docPath', async () => {
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    close.mockResolvedValueOnce({ success: true, data: true })

    await useCanvasStore.getState().closeCanvas(PROJECT)

    expect(close).toHaveBeenCalledWith(DOC_A)
    expect(useCanvasStore.getState().sessions[PROJECT]).toBeUndefined()
  })

  it('close disposes the attached bridge', async () => {
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const bridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, bridge)
    close.mockResolvedValueOnce({ success: true, data: true })

    await useCanvasStore.getState().closeCanvas(PROJECT)

    expect(bridge.dispose).toHaveBeenCalled()
  })
})

describe('canvas-store save + bridge flows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStores()
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
  })

  afterEach(() => {
    resetStores()
  })

  it('save runs the facade save, then acks the bridge with the last reported generation/revision', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const bridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, bridge)

    // The editor reports its identity: ready, then a dirty edit.
    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'ready',
      generation: 2,
      revision: 17
    })
    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'dirty-changed',
      generation: 3,
      revision: 18,
      dirty: true
    })
    expect(useCanvasStore.getState().sessions[PROJECT]).toMatchObject({
      bridgeReady: true,
      dirty: true,
      generation: 3,
      revision: 18
    })

    save.mockResolvedValueOnce({ success: true, data: { ok: true } })
    await useCanvasStore.getState().saveCanvas(PROJECT)

    expect(save).toHaveBeenCalledWith(DOC_A)
    expect(bridge.sendSaveCommitted).toHaveBeenCalledWith(3, 18)
    expect(useCanvasStore.getState().sessions[PROJECT]?.saving).toBe(false)
  })

  it('save failure keeps the session and never acks the bridge', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const bridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, bridge)
    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'dirty-changed',
      generation: 3,
      revision: 18,
      dirty: true
    })

    save.mockResolvedValueOnce({ success: false, error: 'daemon down', code: 'DAEMON_DOWN' })
    await useCanvasStore.getState().saveCanvas(PROJECT)

    expect(bridge.sendSaveCommitted).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().sessions[PROJECT]?.saving).toBe(false)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'canvas-store.saveCanvas' })
    )
  })

  it('a doc re-bind completing mid-save skips the save-committed ack (new editor, old pair)', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const bridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, bridge)
    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'dirty-changed',
      generation: 3,
      revision: 18,
      dirty: true
    })

    // The save resolves AFTER the doc re-bound: the stalled facade save
    // promise hands control back only once the new session exists.
    let resolveSave: (value: { success: true; data: Record<string, unknown> }) => void = () => {}
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )
    const saving = useCanvasStore.getState().saveCanvas(PROJECT)

    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5201/?embed=vscode', DOC_B))
    close.mockResolvedValueOnce({ success: true, data: true })
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_B)

    resolveSave({ success: true, data: { ok: true } })
    await saving

    expect(bridge.sendSaveCommitted).not.toHaveBeenCalled()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'canvas-store.saveCanvas',
        message: expect.stringContaining('skipping the save-committed ack')
      })
    )
  })

  it('a save started before a close+reopen of the SAME doc never acks through the replacement bridge', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const oldBridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, oldBridge)
    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'dirty-changed',
      generation: 3,
      revision: 18,
      dirty: true
    })

    let resolveSave: (value: { success: true; data: Record<string, unknown> }) => void = () => {}
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )
    const saving = useCanvasStore.getState().saveCanvas(PROJECT)

    // Close + reopen the SAME doc: the replacement session carries the same
    // docKey, so only the BRIDGE identity distinguishes the old in-flight
    // save from the replacement session.
    close.mockResolvedValueOnce({ success: true, data: true })
    await useCanvasStore.getState().closeCanvas(PROJECT)
    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5199/?embed=vscode', DOC_A))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const newBridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, newBridge)

    resolveSave({ success: true, data: { ok: true } })
    await saving

    expect(oldBridge.sendSaveCommitted).not.toHaveBeenCalled()
    expect(newBridge.sendSaveCommitted).not.toHaveBeenCalled()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'canvas-store.saveCanvas',
        message: expect.stringContaining('the session changed while the save was in flight')
      })
    )
  })

  it('handleInitFailed records an error session; a later ready recovers it', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    useCanvasStore.getState().handleInitFailed(PROJECT)
    expect(useCanvasStore.getState().sessions[PROJECT]).toMatchObject({
      status: 'error',
      errorCode: 'BRIDGE_INIT_FAILED'
    })

    // Recovery: a late listening→ready round flips the session back open.
    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'ready',
      generation: 2,
      revision: 17
    })
    expect(useCanvasStore.getState().sessions[PROJECT]).toMatchObject({
      status: 'open',
      bridgeReady: true
    })
  })

  it('handleInitFailed never downgrades a session whose bridge already reached ready', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'ready',
      generation: 2,
      revision: 17
    })

    useCanvasStore.getState().handleInitFailed(PROJECT)

    expect(useCanvasStore.getState().sessions[PROJECT]).toMatchObject({
      status: 'open',
      bridgeReady: true
    })
  })

  it('the conflict flow: sync-conflict prompts, resolve sends the mode, conflict-resolved clears', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const bridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, bridge)

    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'sync-conflict',
      generation: 3,
      revision: 18,
      serverVersion: 19
    })
    expect(useCanvasStore.getState().sessions[PROJECT]?.conflict).toEqual({ serverVersion: 19 })

    useCanvasStore.getState().resolveConflict(PROJECT, 'use-local')
    expect(bridge.sendResolveConflict).toHaveBeenCalledWith('use-local', expect.any(String))
    expect(useCanvasStore.getState().sessions[PROJECT]?.conflict).not.toBeNull()

    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'conflict-resolved',
      requestId: 'r1'
    })
    expect(useCanvasStore.getState().sessions[PROJECT]?.conflict).toBeNull()
  })

  it('accept-remote resolution sends the accept-remote mode', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const bridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, bridge)

    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'sync-conflict',
      generation: 3,
      revision: 18,
      serverVersion: 19
    })
    useCanvasStore.getState().resolveConflict(PROJECT, 'accept-remote')
    expect(bridge.sendResolveConflict).toHaveBeenCalledWith('accept-remote', expect.any(String))
  })

  it('pushTheme/pushLocale drive the attached bridge', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const bridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, bridge)

    useCanvasStore.getState().pushTheme(PROJECT, 'dark')
    useCanvasStore.getState().pushLocale(PROJECT, 'en-US')

    expect(bridge.sendTheme).toHaveBeenCalledWith('dark')
    expect(bridge.sendLocale).toHaveBeenCalledWith('en-US')
  })

  it('a session swap on re-open disposes the previous bridge', async () => {
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const bridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, bridge)

    open.mockResolvedValueOnce(openInfo('http://127.0.0.1:5201/?embed=vscode', DOC_B))
    close.mockResolvedValueOnce({ success: true, data: true })
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_B)

    expect(bridge.dispose).toHaveBeenCalled()
    expect(useCanvasStore.getState().sessions[PROJECT]?.bridgeReady).toBe(false)
  })

  it('a repeat open resolving to the SAME embed URL keeps the live bridge + dirty state', async () => {
    const embedUrl = 'http://127.0.0.1:5199/?embed=vscode'
    open.mockResolvedValueOnce(openInfo(embedUrl, DOC_A))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const bridge = fakeBridge()
    useCanvasStore.getState().attachBridge(PROJECT, bridge)
    useCanvasStore.getState().handleBridgeEvent(PROJECT, {
      type: 'dirty-changed',
      generation: 3,
      revision: 18,
      dirty: true
    })

    open.mockResolvedValueOnce(openInfo(embedUrl, DOC_A))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    expect(bridge.dispose).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().sessions[PROJECT]).toMatchObject({
      dirty: true,
      generation: 3,
      revision: 18
    })
  })
})
