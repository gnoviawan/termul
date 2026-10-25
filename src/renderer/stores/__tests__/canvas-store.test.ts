/**
 * Canvas store: the open/close lifecycle against a mocked facade and the
 * mount and persistence flows against a real bridge talking to a fake editor
 * window, with the real workspace store for the singleton tab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  open,
  close,
  setVisible,
  readDocument,
  documentLoaded,
  dirtyChanged,
  writeSnapshot,
  diskChanged,
  resolveConflict,
  crashed,
  toastError,
  toastWarning,
  toastSuccess,
  logFrontendError
} = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  setVisible: vi.fn(),
  readDocument: vi.fn(),
  documentLoaded: vi.fn(),
  dirtyChanged: vi.fn(),
  writeSnapshot: vi.fn(),
  diskChanged: vi.fn(),
  resolveConflict: vi.fn(),
  crashed: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  toastSuccess: vi.fn(),
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/canvas-api', () => ({
  canvasApi: {
    open,
    close,
    setVisible,
    readDocument,
    documentLoaded,
    dirtyChanged,
    writeSnapshot,
    diskChanged,
    resolveConflict,
    crashed
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError }))
vi.mock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(), success: toastSuccess, warning: toastWarning }
}))

const THEME = {
  mode: 'dark',
  background: '#08090a',
  card: '#0f1011',
  foreground: '#e5e5e6',
  mutedForeground: '#8a8f98',
  border: '#23252a',
  primary: '#3b82f6',
  primaryFill: '#3b82f6',
  destructive: '#ef4444'
}
const readCanvasThemeTokens = vi.hoisted(() => vi.fn())
vi.mock('@/lib/canvas-theme', () => ({ readCanvasThemeTokens }))

import type {
  CanvasDirtyOutcome,
  CanvasOpenInfo,
  CanvasPersistenceView,
  CanvasWriteOutcome
} from '@shared/types/canvas.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { asJsonText, createCanvasBridge } from '@/lib/canvas-bridge'
import type { LeafNode } from '@/types/workspace.types'
import { useAppSettingsStore } from '../app-settings-store'
import { type CanvasMount, pinVerdict, useCanvasStore } from '../canvas-store'
import { useProjectStore } from '../project-store'
import { useWorkspaceStore } from '../workspace-store'

const PROJECT = 'proj-1'
const DOC_A = 'C:/proj/design.figcraft'
const DOC_B = 'C:/proj/poster.figcraft'
const CANVAS_ORIGIN = 'http://127.0.0.1:5199'
const PIN = 'termul-v1'
const BIG = '9007199254740993'

const INFO: CanvasOpenInfo = {
  canvasId: 'cv0123456789abcdef',
  baseUrl: CANVAS_ORIGIN,
  canvasToken: 'token-a',
  pinTag: PIN,
  docKey: DOC_A,
  mountSeq: 41,
  evicted: [],
  fallbackFonts: []
}

function openInfo(overrides: Partial<CanvasOpenInfo> = {}): IpcResult<CanvasOpenInfo> {
  return { success: true, data: { ...INFO, ...overrides } }
}

function view(overrides: Partial<CanvasPersistenceView> = {}): CanvasPersistenceView {
  return {
    mountSeq: INFO.mountSeq,
    ready: true,
    dirty: false,
    contentVersion: '3',
    savedVersion: '3',
    saveError: null,
    conflict: null,
    ...overrides
  }
}

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

function session() {
  return useCanvasStore.getState().sessions[PROJECT]
}

function currentMount(): CanvasMount {
  const phase = session()?.phase
  if (phase?.kind !== 'loading' && phase?.kind !== 'ready')
    throw new Error(`no mount: ${phase?.kind}`)
  return phase.mount
}

interface Request {
  id: number
  method: string
  params: string
  mountSeq: number
}

/** What `CanvasShell` does for a mount, against a fake editor window. */
function mountEditor() {
  const { mountSeq } = currentMount()
  const posted: Request[] = []
  const contentWindow = {
    postMessage: (data: Request) => posted.push(data)
  } as unknown as Window
  const send = (data: unknown): void => {
    const event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'origin', { value: CANVAS_ORIGIN })
    Object.defineProperty(event, 'source', { value: contentWindow })
    window.dispatchEvent(event)
  }
  const bridge = createCanvasBridge({
    iframe: { contentWindow } as unknown as HTMLIFrameElement,
    canvasOrigin: CANVAS_ORIGIN,
    mountSeq,
    onEvent: (event) => useCanvasStore.getState().handleBridgeEvent(PROJECT, mountSeq, event)
  })
  useCanvasStore.getState().attachBridge(PROJECT, mountSeq, bridge)
  const answered = new Set<number>()
  const reply = (method: string, result: string): void => {
    const request = posted.find((r) => r.method === method && !answered.has(r.id))
    if (!request) throw new Error(`${method} was not sent`)
    answered.add(request.id)
    send({ id: request.id, ok: true, result, mountSeq })
  }
  const fail = (method: string, code: string): void => {
    const request = posted.find((r) => r.method === method && !answered.has(r.id))
    if (!request) throw new Error(`${method} was not sent`)
    answered.add(request.id)
    send({ id: request.id, ok: false, error: { code, message: 'boom' }, mountSeq })
  }
  return {
    bridge,
    posted,
    send,
    reply,
    fail,
    ready: () => send({ method: 'event.ready', params: '{}', mountSeq }),
    dirty: (dirty: boolean, contentVersion: string) =>
      send({
        method: 'event.dirtyChanged',
        params: `{"dirty":${dirty},"contentVersion":${contentVersion}}`,
        mountSeq
      }),
    sent: (method: string) => posted.filter((r) => r.method === method)
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** Ready → describe → read → openDocument → loaded. */
async function mountReady(bytes: string | null = 'AAEC') {
  readDocument.mockResolvedValueOnce(ok({ bytes }))
  documentLoaded.mockResolvedValueOnce(ok(view()))
  const editor = mountEditor()
  editor.ready()
  editor.reply('host.describe', JSON.stringify({ tag: PIN, engineVersion: '0.6.0' }))
  await flush()
  if (bytes !== null) {
    editor.reply('host.openDocument', '{"contentVersion":3}')
    await flush()
  }
  return editor
}

function canvasTabs() {
  const root = useWorkspaceStore.getState().root
  return root.type === 'leaf' ? root.tabs.filter((t) => t.type === 'canvas') : []
}

function resetStores(): void {
  useCanvasStore.setState({ sessions: {} })
  useWorkspaceStore.setState(() => {
    const root: LeafNode = { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null }
    return { root, activePaneId: 'pane-root', fullscreenPaneId: null, agentLauncherPaneId: null }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  readCanvasThemeTokens.mockReturnValue(THEME)
  close.mockResolvedValue({
    success: true,
    data: { unmounted: true, savedVersion: null, discarded: false }
  })
  resetStores()
})

afterEach(async () => {
  await useCanvasStore.getState().unmountCanvas(PROJECT)
  vi.unstubAllEnvs()
  resetStores()
})

describe('open and close', () => {
  it('a successful open starts loading the host-numbered mount and focuses the tab', async () => {
    open.mockResolvedValueOnce(openInfo())
    await expect(useCanvasStore.getState().openCanvas(PROJECT, DOC_A)).resolves.toBe(true)

    expect(open).toHaveBeenCalledWith(DOC_A, PROJECT, {
      autosaveMs: 1500,
      autosaveMaxMs: 10000,
      leaseGraceMs: 5000,
      maxMounted: 2,
      crashTimeouts: 3
    })
    expect(session()?.phase.kind).toBe('loading')
    expect(currentMount()).toEqual({ mountSeq: 41, info: INFO })
    expect(canvasTabs()).toEqual([
      expect.objectContaining({ id: `canvas-${PROJECT}`, projectId: PROJECT, docPath: DOC_A })
    ])
  })

  it('the same document under another spelling of its path keeps the mount', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    await expect(
      useCanvasStore.getState().openCanvas(PROJECT, 'C:\\proj/design.figcraft')
    ).resolves.toBe(true)
    await expect(
      useCanvasStore.getState().openCanvas(PROJECT, 'c:\\proj\\design.figcraft')
    ).resolves.toBe(true)
    expect(close).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    expect(currentMount().mountSeq).toBe(41)
  })

  it('a repeat open of the mounted doc keeps the mount; another doc remounts', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const first = currentMount()
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    expect(currentMount()).toBe(first)
    expect(open).toHaveBeenCalledTimes(1)

    open.mockResolvedValueOnce(openInfo({ docKey: DOC_B, mountSeq: 42 }))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_B)
    expect(session()?.docPath).toBe(DOC_B)
    expect(currentMount().mountSeq).toBe(42)
    expect(close).toHaveBeenCalledWith(PROJECT, INFO.mountSeq, false)
    expect(canvasTabs()).toHaveLength(1)
  })

  it('a failed first open leaves no session and no tab', async () => {
    open.mockResolvedValueOnce({
      success: false,
      error: 'canvas open is unavailable on the mobile web shell',
      code: 'UNSUPPORTED_SURFACE'
    })
    await expect(useCanvasStore.getState().openCanvas(PROJECT, DOC_A)).resolves.toBe(false)

    expect(session()).toBeUndefined()
    expect(canvasTabs()).toHaveLength(0)
    expect(toastError).toHaveBeenCalled()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('UNSUPPORTED_SURFACE') })
    )
  })

  it('an unmount that lands while the open is in flight wins', async () => {
    let resolveOpen: (value: IpcResult<CanvasOpenInfo>) => void = () => {}
    open.mockReturnValueOnce(new Promise((resolve) => (resolveOpen = resolve)))
    const opening = useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    await useCanvasStore.getState().unmountCanvas(PROJECT)
    resolveOpen(openInfo())

    await expect(opening).resolves.toBe('superseded')
    expect(session()).toBeUndefined()
    expect(canvasTabs()).toHaveLength(0)
    expect(close.mock.calls).toEqual([[PROJECT, INFO.mountSeq]])
  })

  it('an unmount the host ran drops the session: pending calls resolve CANVAS_CLOSED', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    mountEditor()
    const pending = useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')

    await useCanvasStore.getState().unmountCanvas(PROJECT)

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
    expect(close).toHaveBeenCalledWith(PROJECT, INFO.mountSeq, false)
    expect(session()).toBeUndefined()
    await expect(
      useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')
    ).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
  })
})

describe('unmount refused by the host', () => {
  it('a failed save keeps the session and its mount, and a discard then unmounts', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    mountEditor()
    const mount = currentMount()
    close.mockResolvedValueOnce({
      success: false,
      error: 'could not snapshot the canvas',
      code: 'SAVE_FAILED'
    })

    const refused = await useCanvasStore.getState().unmountCanvas(PROJECT)

    expect(refused).toMatchObject({ success: false, code: 'SAVE_FAILED' })
    expect(currentMount()).toBe(mount)
    expect(session()?.closing).toBe(false)
    const pending = useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')
    await expect(Promise.race([pending, Promise.resolve('waiting')])).resolves.toBe('waiting')

    await expect(useCanvasStore.getState().unmountCanvas(PROJECT, true)).resolves.toMatchObject({
      success: true
    })
    expect(close).toHaveBeenLastCalledWith(PROJECT, INFO.mountSeq, true)
    expect(session()).toBeUndefined()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
  })
})

describe('lease lost to another window', () => {
  it('the saved-elsewhere mount shows as open elsewhere: bridge gone, calls CANVAS_CLOSED', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    const editor = await mountReady()
    editor.dirty(true, '4')
    const pending = useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')

    useCanvasStore.getState().leaseLost(PROJECT, INFO.mountSeq - 1, 'elsewhere')
    expect(session()?.phase.kind).toBe('ready')
    useCanvasStore.getState().leaseLost(PROJECT, INFO.mountSeq, 'elsewhere')

    expect(session()?.phase).toEqual({ kind: 'elsewhere' })
    expect(session()?.dirty).toBe(false)
    expect(session()?.docPath).toBe(DOC_A)
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
    await expect(
      useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')
    ).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
    expect(canvasTabs()).toHaveLength(1)
  })

  it('a mount the host dropped after the grace shows as closed, not elsewhere', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    useCanvasStore.getState().leaseLost(PROJECT, INFO.mountSeq, 'expired')

    expect(session()?.phase).toMatchObject({ kind: 'failed', code: 'CANVAS_CLOSED' })
  })

  it("a mount the cap evicted for another window's open shows as unloaded", async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    await mountReady()
    useCanvasStore.getState().leaseLost(PROJECT, INFO.mountSeq, 'evicted')

    expect(session()?.phase).toEqual({ kind: 'unloaded', reason: 'evicted', message: null })
    expect(session()?.docPath).toBe(DOC_A)
    await expect(
      useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')
    ).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
  })

  it('take back opens the canvas again here with a new mount', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    useCanvasStore.getState().leaseLost(PROJECT, INFO.mountSeq, 'elsewhere')

    open.mockResolvedValueOnce(openInfo({ mountSeq: 57 }))
    await expect(useCanvasStore.getState().openCanvas(PROJECT, DOC_A)).resolves.toBe(true)

    expect(open).toHaveBeenLastCalledWith(DOC_A, PROJECT, expect.any(Object))
    expect(close).not.toHaveBeenCalled()
    expect(session()?.phase.kind).toBe('loading')
    expect(currentMount().mountSeq).toBe(57)
  })

  it('a refused take back keeps the elsewhere state and says why', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    useCanvasStore.getState().leaseLost(PROJECT, INFO.mountSeq, 'elsewhere')

    open.mockResolvedValueOnce({
      success: false,
      error: 'This canvas is open in another window, and it could not be saved there',
      code: 'CANVAS_OPEN_ELSEWHERE'
    })
    await expect(useCanvasStore.getState().openCanvas(PROJECT, DOC_A)).resolves.toBe(false)

    expect(session()?.phase).toEqual({ kind: 'elsewhere' })
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('could not be saved there'))
  })

  it('closing an elsewhere canvas here leaves the mount in the other window alone', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    useCanvasStore.getState().leaseLost(PROJECT, INFO.mountSeq, 'elsewhere')

    await expect(useCanvasStore.getState().unmountCanvas(PROJECT)).resolves.toMatchObject({
      success: true,
      data: { unmounted: false }
    })
    expect(close).not.toHaveBeenCalled()
    expect(session()).toBeUndefined()
  })
})

describe('mount and load', () => {
  beforeEach(async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
  })

  it('event.ready checks the pin, loads the document, then sends theme and locale', async () => {
    readDocument.mockResolvedValueOnce(ok({ bytes: 'AAEC' }))
    documentLoaded.mockResolvedValueOnce(ok(view({ contentVersion: BIG, savedVersion: BIG })))
    const editor = mountEditor()
    editor.ready()
    expect(editor.posted.map((r) => r.method)).toEqual(['host.describe'])
    editor.reply('host.describe', JSON.stringify({ tag: PIN, engineVersion: '0.6.0' }))
    await flush()

    expect(readDocument).toHaveBeenCalledWith(PROJECT, 41)
    expect(editor.sent('host.openDocument').map((r) => r.params)).toEqual(['{"bytes":"AAEC"}'])
    expect(session()?.phase.kind).toBe('loading')
    editor.reply('host.openDocument', `{"contentVersion":${BIG}}`)
    await flush()

    expect(documentLoaded).toHaveBeenCalledWith(PROJECT, 41, `{"contentVersion":${BIG}}`)
    expect(session()).toMatchObject({
      phase: { kind: 'ready' },
      dirty: false,
      contentVersion: BIG,
      savedVersion: BIG
    })
    expect(editor.sent('host.theme').map((r) => JSON.parse(r.params))).toEqual([{ tokens: THEME }])
    expect(editor.sent('host.locale').map((r) => JSON.parse(r.params))).toEqual([
      { bcp47: navigator.language }
    ])
  })

  it('names the loaded file for the editor by its project path and project', async () => {
    useProjectStore.setState({
      projects: [{ id: PROJECT, name: 'Proj', color: 'blue', path: 'c:\\proj' }]
    })
    const editor = await mountReady()
    expect(editor.sent('host.file').map((r) => JSON.parse(r.params))).toEqual([
      { name: 'design', path: 'design.figcraft', location: 'Proj' }
    ])
    const methods = editor.posted.map((r) => r.method)
    expect(methods.indexOf('host.file')).toBeGreaterThan(methods.indexOf('host.openDocument'))
    useProjectStore.setState({ projects: [] })
  })

  it('a document that does not exist yet starts empty: no host.openDocument, null ack', async () => {
    const editor = await mountReady(null)
    expect(editor.sent('host.openDocument')).toHaveLength(0)
    expect(documentLoaded).toHaveBeenCalledWith(PROJECT, 41, null)
    expect(session()?.phase.kind).toBe('ready')
    expect(editor.sent('host.file').map((r) => JSON.parse(r.params))).toEqual([
      { name: 'design', path: 'design.figcraft', location: null }
    ])
  })

  it('a document the editor cannot open fails the mount and never reports it loaded', async () => {
    readDocument.mockResolvedValueOnce(ok({ bytes: 'AAEC' }))
    const editor = mountEditor()
    editor.ready()
    editor.reply('host.describe', JSON.stringify({ tag: PIN, engineVersion: '0.6.0' }))
    await flush()
    editor.fail('host.openDocument', 'ENGINE_ERROR')
    await flush()

    expect(session()?.phase).toMatchObject({ kind: 'failed', code: 'DOCUMENT_LOAD_FAILED' })
    expect(documentLoaded).not.toHaveBeenCalled()
  })

  it('a theme change re-sends host.theme to the same mount, without a remount', async () => {
    const editor = await mountReady()
    readCanvasThemeTokens.mockReturnValue({ ...THEME, mode: 'light', background: '#ffffff' })
    useCanvasStore.getState().pushTheme(PROJECT)
    useCanvasStore.getState().pushLocale(PROJECT)

    expect(editor.sent('host.theme').map((r) => JSON.parse(r.params).tokens.mode)).toEqual([
      'dark',
      'light'
    ])
    expect(editor.sent('host.locale')).toHaveLength(2)
    expect(currentMount().mountSeq).toBe(41)
  })

  it('a second event.ready on a ready mount reloads the last save before anything else', async () => {
    const editor = await mountReady()
    readDocument.mockResolvedValueOnce(ok({ bytes: 'c2F2ZWQ=' }))
    documentLoaded.mockResolvedValueOnce(ok(view({ contentVersion: '1', savedVersion: '1' })))
    editor.ready()
    expect(session()?.phase.kind).toBe('loading')

    editor.dirty(true, '2')
    expect(dirtyChanged).not.toHaveBeenCalled()
    editor.reply('host.describe', JSON.stringify({ tag: PIN, engineVersion: '0.6.0' }))
    await flush()
    expect(readDocument).toHaveBeenCalledTimes(2)
    expect(editor.sent('host.openDocument').at(-1)?.params).toBe('{"bytes":"c2F2ZWQ="}')
    editor.reply('host.openDocument', '{"contentVersion":1}')
    await flush()

    expect(documentLoaded).toHaveBeenLastCalledWith(PROJECT, 41, '{"contentVersion":1}')
    expect(session()).toMatchObject({
      phase: { kind: 'ready' },
      contentVersion: '1',
      savedVersion: '1'
    })
    expect(editor.sent('host.theme')).toHaveLength(2)
    expect(editor.sent('host.locale')).toHaveLength(2)
    expect(writeSnapshot).not.toHaveBeenCalled()
  })

  it('a pin mismatch is only logged in dev builds', async () => {
    vi.stubEnv('PROD', false)
    readDocument.mockResolvedValueOnce(ok({ bytes: null }))
    documentLoaded.mockResolvedValueOnce(ok(view()))
    const editor = mountEditor()
    editor.ready()
    editor.reply('host.describe', JSON.stringify({ tag: 'dev', engineVersion: '0.6.0' }))
    await flush()

    expect(session()?.phase.kind).toBe('ready')
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('bundle=dev') })
    )
  })

  it('a pin mismatch refuses the mount in release builds before any load', async () => {
    vi.stubEnv('PROD', true)
    const editor = mountEditor()
    editor.ready()
    editor.reply('host.describe', JSON.stringify({ tag: 'dev', engineVersion: '0.6.0' }))
    await flush()

    expect(session()?.phase).toMatchObject({ kind: 'failed', code: 'BUNDLE_PIN_MISMATCH' })
    expect(readDocument).not.toHaveBeenCalled()
    expect(editor.sent('host.theme')).toHaveLength(0)
    await expect(editor.bridge.call('document.inspect')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CANVAS_CLOSED' }
    })
  })

  it('forwards agent calls as opaque text', async () => {
    const editor = mountEditor()
    const params = asJsonText('{"command":"object.rename","params":{"id":18446744073709551615}}')
    const call = useCanvasStore.getState().callCanvas(PROJECT, 'engine.execute', params)
    editor.ready()

    const request = editor.sent('engine.execute')[0]
    expect(request?.params).toBe(params)
    editor.reply('engine.execute', '{"id":18446744073709551615}')
    await expect(call).resolves.toEqual({ ok: true, result: '{"id":18446744073709551615}' })
  })

  it('ignores events addressed to a previous mount', async () => {
    const stale = mountEditor()
    open.mockResolvedValueOnce(openInfo({ docKey: DOC_B, mountSeq: 42 }))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_B)

    useCanvasStore.getState().handleBridgeEvent(PROJECT, 41, { method: 'event.ready' })
    useCanvasStore
      .getState()
      .handleBridgeEvent(PROJECT, 41, { method: 'event.crashed', reason: 'old' })

    expect(session()?.phase.kind).toBe('loading')
    expect(stale.posted).toHaveLength(0)
  })

  it('an editor crash remounts from the last save under the new mountSeq', async () => {
    const editor = mountEditor()
    editor.ready()
    const pending = useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')
    const remount = {
      previousMountSeq: 41,
      mountSeq: 43,
      reason: 'the editor crashed: panic',
      lost: { count: 4, sinceMs: 1_700_000_000_000 }
    }
    crashed.mockResolvedValueOnce(ok(remount))
    editor.send({ method: 'event.crashed', params: '{"reason":"panic"}', mountSeq: 41 })
    await flush()

    expect(crashed).toHaveBeenCalledWith(PROJECT, 41, 'panic')
    expect(session()?.phase).toEqual({
      kind: 'loading',
      mount: { mountSeq: 43, info: { ...INFO, mountSeq: 43 } }
    })
    expect(session()?.crash).toEqual(remount)
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
  })

  it('a remount that crashes again before it loaded is not retried', async () => {
    const editor = mountEditor()
    editor.ready()
    crashed.mockResolvedValueOnce(
      ok({ previousMountSeq: 41, mountSeq: 43, reason: 'the editor crashed: panic', lost: null })
    )
    editor.send({ method: 'event.crashed', params: '{"reason":"panic"}', mountSeq: 41 })
    await flush()
    const again = mountEditor()
    again.send({ method: 'event.crashed', params: '{"reason":"panic"}', mountSeq: 43 })
    await flush()

    expect(crashed).toHaveBeenCalledTimes(1)
    expect(session()?.phase).toMatchObject({ kind: 'failed', code: 'EDITOR_CRASHED' })
  })

  it('a crash the host cannot remount fails the mount', async () => {
    const editor = mountEditor()
    editor.ready()
    crashed.mockResolvedValueOnce({ success: false, error: 'gone', code: 'CANVAS_CLOSED' })
    editor.send({ method: 'event.crashed', params: '{"reason":"panic"}', mountSeq: 41 })
    await flush()
    expect(session()?.phase).toMatchObject({ kind: 'failed', code: 'EDITOR_CRASHED' })
  })

  it('a remount notice for a mount this window does not hold changes nothing', () => {
    mountEditor()
    const applied = useCanvasStore
      .getState()
      .applyRemount(PROJECT, { previousMountSeq: 7, mountSeq: 8, reason: 'x', lost: null })
    expect(applied).toBe(false)
    expect(currentMount().mountSeq).toBe(41)
  })
})

describe('fallback fonts (#1421)', () => {
  const FONTS = ['host-fonts/seguisym.ttf', 'host-fonts/msyh.ttc']

  beforeEach(async () => {
    open.mockResolvedValueOnce(openInfo({ fallbackFonts: FONTS }))
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    readDocument.mockResolvedValueOnce(ok({ bytes: 'AAEC' }))
    documentLoaded.mockResolvedValueOnce(ok(view()))
  })

  it('the lent fonts load before the document, so its first render has them', async () => {
    const editor = mountEditor()
    editor.ready()
    editor.reply('host.describe', JSON.stringify({ tag: PIN, engineVersion: '0.6.0' }))
    await flush()
    expect(editor.sent('host.fallbackFonts').map((r) => JSON.parse(r.params))).toEqual([
      { urls: FONTS }
    ])
    expect(editor.sent('host.openDocument')).toHaveLength(0)

    editor.reply('host.fallbackFonts', '{"families":["Segoe UI Symbol"],"failed":[]}')
    await flush()
    editor.reply('host.openDocument', '{"contentVersion":3}')
    await flush()
    expect(session()?.phase.kind).toBe('ready')
  })

  it('a bundle without host.fallbackFonts still mounts', async () => {
    const editor = mountEditor()
    editor.ready()
    editor.reply('host.describe', JSON.stringify({ tag: PIN, engineVersion: '0.6.0' }))
    await flush()
    editor.fail('host.fallbackFonts', 'UNKNOWN_METHOD')
    await flush()
    editor.reply('host.openDocument', '{"contentVersion":3}')
    await flush()

    expect(session()?.phase.kind).toBe('ready')
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', message: expect.stringContaining('UNKNOWN_METHOD') })
    )
  })

  it('a font the editor could not load is logged and the mount goes on', async () => {
    const editor = mountEditor()
    editor.ready()
    editor.reply('host.describe', JSON.stringify({ tag: PIN, engineVersion: '0.6.0' }))
    await flush()
    editor.reply(
      'host.fallbackFonts',
      '{"families":[],"failed":[{"url":"host-fonts/msyh.ttc","error":"HTTP 404"}]}'
    )
    await flush()
    editor.reply('host.openDocument', '{"contentVersion":3}')
    await flush()

    expect(session()?.phase.kind).toBe('ready')
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('HTTP 404') })
    )
  })
})

describe('persistence', () => {
  beforeEach(async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
  })

  it('dirty changes before the document loaded are neither shown nor forwarded', () => {
    const editor = mountEditor()
    editor.ready()
    editor.dirty(true, '7')
    expect(session()?.dirty).toBe(false)
    expect(dirtyChanged).not.toHaveBeenCalled()
  })

  it('a dirty change shows at once and is forwarded with the version as text', async () => {
    const editor = await mountReady()
    dirtyChanged.mockReturnValueOnce(new Promise(() => {}))
    editor.dirty(true, BIG)

    expect(session()).toMatchObject({ dirty: true, contentVersion: BIG })
    expect(dirtyChanged).toHaveBeenCalledWith(PROJECT, 41, true, BIG)
  })

  it('saveDue runs snapshot, host write, host.markSaved and projects the result', async () => {
    const editor = await mountReady()
    const due: CanvasDirtyOutcome = {
      kind: 'saveDue',
      view: view({ dirty: true, contentVersion: BIG, savedVersion: '3' })
    }
    dirtyChanged.mockResolvedValueOnce(ok(due))
    let resolveWrite: (value: IpcResult<CanvasWriteOutcome>) => void = () => {}
    writeSnapshot.mockReturnValueOnce(new Promise((resolve) => (resolveWrite = resolve)))
    editor.dirty(true, BIG)
    await flush()

    const snapshotText = `{"contentVersion":${BIG},"bytes":"Zm9v"}`
    editor.reply('host.snapshot', snapshotText)
    await flush()
    expect(writeSnapshot).toHaveBeenCalledWith(PROJECT, 41, snapshotText)
    expect(session()?.saving).toBe(true)

    resolveWrite(
      ok({
        view: view({ dirty: true, contentVersion: BIG, savedVersion: BIG }),
        markSaved: BIG
      })
    )
    await flush()
    expect(editor.sent('host.markSaved').map((r) => r.params)).toEqual([
      `{"contentVersion":${BIG}}`
    ])

    dirtyChanged.mockResolvedValueOnce(
      ok({ kind: 'idle', view: view({ contentVersion: BIG, savedVersion: BIG }) })
    )
    editor.reply('host.markSaved', `{"dirty":false,"contentVersion":${BIG}}`)
    editor.dirty(false, BIG)
    await flush()
    expect(session()).toMatchObject({
      dirty: false,
      savedVersion: BIG,
      saving: false,
      saveError: null
    })
  })

  it('a failed dirty notification shows a save error and is retried on the next tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const editor = await mountReady()
      dirtyChanged
        .mockResolvedValueOnce({ success: false, error: 'offline', code: 'NETWORK_ERROR' })
        .mockResolvedValueOnce(
          ok({ kind: 'idle', view: view({ dirty: true, contentVersion: '4' }) })
        )
      editor.dirty(true, '4')
      await flush()
      expect(session()?.saveError).toContain('offline')
      expect(dirtyChanged).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1500)
      await flush()
      expect(dirtyChanged).toHaveBeenCalledTimes(2)
      expect(dirtyChanged).toHaveBeenLastCalledWith(PROJECT, 41, true, '4')
      expect(session()?.saveError).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('CANVAS_CLOSED from the host on a mount this window holds shows the canvas closed', async () => {
    const editor = await mountReady()
    dirtyChanged.mockResolvedValueOnce({
      success: false,
      error: 'the canvas is not mounted',
      code: 'CANVAS_CLOSED'
    })
    editor.dirty(true, '4')
    await flush()
    expect(session()?.phase).toMatchObject({
      kind: 'failed',
      code: 'CANVAS_CLOSED',
      mountSeq: null
    })
    await expect(editor.bridge.call('document.inspect')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CANVAS_CLOSED' }
    })
  })

  it('a superseded notification changes nothing and takes no snapshot', async () => {
    const editor = await mountReady()
    dirtyChanged.mockResolvedValueOnce(ok({ kind: 'superseded' }))
    editor.dirty(true, '4')
    await flush()
    expect(session()).toMatchObject({ dirty: true, contentVersion: '4', savedVersion: '3' })
    expect(editor.sent('host.snapshot')).toHaveLength(0)
  })

  it('a failed write keeps the saved version, shows the error and never marks saved', async () => {
    const editor = await mountReady()
    dirtyChanged.mockResolvedValueOnce(
      ok({ kind: 'saveDue', view: view({ dirty: true, contentVersion: '4' }) })
    )
    writeSnapshot.mockResolvedValueOnce(
      ok({
        view: view({
          dirty: true,
          contentVersion: '4',
          savedVersion: '3',
          saveError: 'could not write the canvas document: disk full'
        }),
        markSaved: null
      })
    )
    editor.dirty(true, '4')
    await flush()
    editor.reply('host.snapshot', '{"contentVersion":4,"bytes":"Zm9v"}')
    await flush()

    expect(session()).toMatchObject({
      savedVersion: '3',
      saving: false,
      saveError: 'could not write the canvas document: disk full'
    })
    expect(editor.sent('host.markSaved')).toHaveLength(0)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining(PROJECT) })
    )
  })

  it('user Save writes immediately without waiting for a debounce', async () => {
    const editor = await mountReady()
    writeSnapshot.mockResolvedValueOnce(ok({ view: view({ savedVersion: '3' }), markSaved: '3' }))
    const saving = useCanvasStore.getState().saveCanvas(PROJECT)
    await flush()
    editor.reply('host.snapshot', '{"contentVersion":3,"bytes":"Zm9v"}')
    await flush()
    editor.reply('host.markSaved', '{"dirty":false,"contentVersion":3}')

    await expect(saving).resolves.toBe(true)
    expect(dirtyChanged).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('user Save before the document loaded does nothing', async () => {
    mountEditor()
    await expect(useCanvasStore.getState().saveCanvas(PROJECT)).resolves.toBe(false)
    expect(writeSnapshot).not.toHaveBeenCalled()
  })

  it('a failed user Save toasts', async () => {
    const editor = await mountReady()
    const saving = useCanvasStore.getState().saveCanvas(PROJECT)
    await flush()
    editor.fail('host.snapshot', 'ENGINE_ERROR')
    await expect(saving).resolves.toBe(false)
    expect(toastError).toHaveBeenCalled()
    expect(session()?.saveError).toContain('ENGINE_ERROR')
  })
})

describe('disk changes (AD-27)', () => {
  const CONFLICT = { diskHash: 'ab'.repeat(32), version: '5' }

  beforeEach(async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
  })

  async function conflicted() {
    const editor = await mountReady()
    diskChanged.mockResolvedValueOnce(
      ok({ kind: 'conflict', view: view({ dirty: true, conflict: CONFLICT }) })
    )
    await useCanvasStore.getState().checkDisk(PROJECT)
    return editor
  }

  it('a change under a clean editor reloads it with the disk bytes', async () => {
    const editor = await mountReady()
    diskChanged.mockResolvedValueOnce(ok({ kind: 'reload', view: view(), bytes: 'bmV3' }))
    documentLoaded.mockResolvedValueOnce(ok(view({ contentVersion: '9', savedVersion: '9' })))
    const checking = useCanvasStore.getState().checkDisk(PROJECT)
    await flush()

    expect(diskChanged).toHaveBeenCalledWith(PROJECT, 41)
    expect(editor.sent('host.openDocument').at(-1)?.params).toBe('{"bytes":"bmV3"}')
    editor.reply('host.openDocument', '{"contentVersion":9}')
    await checking

    expect(documentLoaded).toHaveBeenLastCalledWith(PROJECT, 41, '{"contentVersion":9}')
    expect(session()?.savedVersion).toBe('9')
    expect(toastWarning).not.toHaveBeenCalled()
    expect(editor.sent('host.file'), 'the reloaded document is named again').toHaveLength(2)
  })

  it('a reload is not applied once the editor moved past the version the host judged clean', async () => {
    const editor = await mountReady()
    dirtyChanged.mockReturnValueOnce(new Promise(() => {}))
    editor.dirty(true, '4')
    diskChanged
      .mockResolvedValueOnce(ok({ kind: 'reload', view: view(), bytes: 'bmV3' }))
      .mockResolvedValueOnce(
        ok({ kind: 'conflict', view: view({ dirty: true, conflict: CONFLICT }) })
      )
    await useCanvasStore.getState().checkDisk(PROJECT)

    expect(editor.sent('host.openDocument')).toHaveLength(1)
    expect(diskChanged).toHaveBeenLastCalledWith(PROJECT, 41, true)
    expect(session()?.conflict).toEqual(CONFLICT)
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })

  it('a reload the editor refuses is reported, and the host raises a conflict', async () => {
    const editor = await mountReady()
    diskChanged
      .mockResolvedValueOnce(ok({ kind: 'reload', view: view(), bytes: 'bmV3' }))
      .mockResolvedValueOnce(ok({ kind: 'conflict', view: view({ conflict: CONFLICT }) }))
    const checking = useCanvasStore.getState().checkDisk(PROJECT)
    await flush()
    editor.fail('host.openDocument', 'ENGINE_ERROR')
    await checking

    expect(diskChanged).toHaveBeenLastCalledWith(PROJECT, 41, true)
    expect(documentLoaded).toHaveBeenCalledTimes(1)
    expect(session()?.conflict).toEqual(CONFLICT)
  })

  it('a change under unsaved edits raises the conflict once', async () => {
    await conflicted()
    expect(session()?.conflict).toEqual(CONFLICT)
    diskChanged.mockResolvedValueOnce(
      ok({ kind: 'conflict', view: view({ dirty: true, conflict: CONFLICT }) })
    )
    await useCanvasStore.getState().checkDisk(PROJECT)
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })

  it('a save the host refused for a conflict is not a save error', async () => {
    const editor = await mountReady()
    writeSnapshot.mockResolvedValueOnce(
      ok({ view: view({ dirty: true, conflict: CONFLICT }), markSaved: null })
    )
    const saving = useCanvasStore.getState().saveCanvas(PROJECT)
    await flush()
    editor.reply('host.snapshot', '{"contentVersion":4,"bytes":"Zm9v"}')
    await expect(saving).resolves.toBe(false)
    expect(session()?.conflict).toEqual(CONFLICT)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('keep mine clears the conflict, then saves the editor over the disk', async () => {
    const editor = await conflicted()
    resolveConflict.mockResolvedValueOnce(
      ok({ view: view({ dirty: true }), reload: null, copyPath: null })
    )
    writeSnapshot.mockResolvedValueOnce(ok({ view: view({ savedVersion: '5' }), markSaved: '5' }))
    const resolving = useCanvasStore.getState().resolveConflict(PROJECT, 'keepMine')
    await flush()
    expect(resolveConflict).toHaveBeenCalledWith(PROJECT, 41, 'keepMine', undefined)
    expect(session()?.conflict).toBeNull()
    editor.reply('host.snapshot', '{"contentVersion":5,"bytes":"bWluZQ=="}')
    await flush()
    editor.reply('host.markSaved', '{"dirty":false,"contentVersion":5}')

    await expect(resolving).resolves.toBe(true)
    expect(writeSnapshot).toHaveBeenCalledWith(
      PROJECT,
      41,
      '{"contentVersion":5,"bytes":"bWluZQ=="}'
    )
    expect(session()?.resolving).toBe(false)
  })

  it('take disk reloads the editor from the bytes the host read', async () => {
    const editor = await conflicted()
    resolveConflict.mockResolvedValueOnce(ok({ view: view(), reload: 'ZGlzaw==', copyPath: null }))
    documentLoaded.mockResolvedValueOnce(ok(view({ contentVersion: '6', savedVersion: '6' })))
    const resolving = useCanvasStore.getState().resolveConflict(PROJECT, 'takeDisk')
    await flush()
    editor.reply('host.openDocument', '{"contentVersion":6}')

    await expect(resolving).resolves.toBe(true)
    expect(editor.sent('host.openDocument').at(-1)?.params).toBe('{"bytes":"ZGlzaw=="}')
    expect(session()).toMatchObject({ conflict: null, savedVersion: '6' })
    expect(writeSnapshot).not.toHaveBeenCalled()
  })

  it('save a copy snapshots the editor for the host, then reloads the disk', async () => {
    const editor = await conflicted()
    resolveConflict.mockResolvedValueOnce(
      ok({
        view: view(),
        reload: 'ZGlzaw==',
        copyPath: 'C:/proj/design.conflict-20261018-101500.figcraft'
      })
    )
    documentLoaded.mockResolvedValueOnce(ok(view()))
    const resolving = useCanvasStore.getState().resolveConflict(PROJECT, 'saveCopy')
    await flush()
    editor.reply('host.snapshot', '{"contentVersion":5,"bytes":"bWluZQ=="}')
    await flush()
    expect(resolveConflict).toHaveBeenCalledWith(
      PROJECT,
      41,
      'saveCopy',
      '{"contentVersion":5,"bytes":"bWluZQ=="}'
    )
    editor.reply('host.openDocument', '{"contentVersion":3}')

    await expect(resolving).resolves.toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Saved your version as design.conflict-20261018-101500.figcraft'
    )
  })

  it('a refused resolution keeps the conflict and says why', async () => {
    await conflicted()
    resolveConflict.mockResolvedValueOnce({
      success: false,
      error: 'the canvas document was deleted',
      code: 'DOCUMENT_DELETED'
    })
    await expect(useCanvasStore.getState().resolveConflict(PROJECT, 'takeDisk')).resolves.toBe(
      false
    )
    expect(session()?.conflict).toEqual(CONFLICT)
    expect(toastError).toHaveBeenCalledWith(
      'Could not resolve the canvas conflict: the canvas document was deleted'
    )
  })
})

describe('pinVerdict', () => {
  it('matches only the exact pinned tag and refuses only in release', () => {
    expect(pinVerdict('termul-v1', 'termul-v1', true)).toBe('match')
    expect(pinVerdict('dev', 'termul-v1', false)).toBe('mismatch-logged')
    expect(pinVerdict('dev', 'termul-v1', true)).toBe('mismatch-refused')
    expect(pinVerdict(null, 'termul-v1', true)).toBe('mismatch-refused')
  })
})

describe('mount cap (AD-26)', () => {
  const OTHER = 'proj-2'
  const other = () => useCanvasStore.getState().sessions[OTHER]

  const openOther = async (): Promise<void> => {
    open.mockResolvedValueOnce(openInfo({ mountSeq: 50, canvasId: 'cv0000000000000002' }))
    await useCanvasStore.getState().openCanvas(OTHER, DOC_B)
  }

  afterEach(() => {
    useAppSettingsStore.setState({
      settings: { ...useAppSettingsStore.getState().settings, canvasMaxMounted: 2 }
    })
  })

  it('sends the canvas.max_mounted setting with each open', async () => {
    useAppSettingsStore.setState({
      settings: { ...useAppSettingsStore.getState().settings, canvasMaxMounted: 3 }
    })
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    expect(open).toHaveBeenCalledWith(DOC_A, PROJECT, expect.objectContaining({ maxMounted: 3 }))
  })

  it('a canvas the host evicted becomes unloaded and loses its editor', async () => {
    await openOther()
    open.mockResolvedValueOnce(
      openInfo({ evicted: [{ projectId: OTHER, reason: 'mount cap reached' }] })
    )
    await expect(useCanvasStore.getState().openCanvas(PROJECT, DOC_A)).resolves.toBe(true)

    expect(other()?.phase).toEqual({ kind: 'unloaded', reason: 'evicted', message: null })
    expect(other()?.docPath).toBe(DOC_B)
    expect(other()?.dirty).toBe(false)
    expect(session()?.phase.kind).toBe('loading')
    await expect(
      useCanvasStore.getState().callCanvas(OTHER, 'document.inspect')
    ).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(OTHER) })
    )
  })

  it('an eviction is applied even when the open that caused it was superseded', async () => {
    await openOther()
    let resolveOpen: (value: IpcResult<CanvasOpenInfo>) => void = () => {}
    open.mockReturnValueOnce(new Promise((resolve) => (resolveOpen = resolve)))
    const opening = useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    await useCanvasStore.getState().unmountCanvas(PROJECT)
    resolveOpen(openInfo({ evicted: [{ projectId: OTHER, reason: 'mount cap reached' }] }))

    await expect(opening).resolves.toBe('superseded')
    expect(other()?.phase.kind).toBe('unloaded')
  })

  it('reopening an unloaded canvas opens it again and may evict another', async () => {
    await openOther()
    useCanvasStore.getState().markUnloaded(OTHER, 'evicted')
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    open.mockResolvedValueOnce(
      openInfo({
        mountSeq: 60,
        canvasId: 'cv0000000000000002',
        evicted: [{ projectId: PROJECT, reason: 'mount cap reached' }]
      })
    )
    await useCanvasStore.getState().openCanvas(OTHER, DOC_B)

    expect(open).toHaveBeenLastCalledWith(DOC_B, OTHER, expect.objectContaining({ maxMounted: 2 }))
    expect(other()?.phase.kind).toBe('loading')
    expect(session()?.phase.kind).toBe('unloaded')
  })

  it('a refused reopen leaves the canvas unloaded, not failed', async () => {
    await openOther()
    useCanvasStore.getState().markUnloaded(OTHER, 'evicted')
    open.mockResolvedValueOnce({
      success: false,
      error: 'listener down',
      code: 'BUNDLE_LISTENER_DOWN'
    })

    await expect(useCanvasStore.getState().openCanvas(OTHER, DOC_B)).resolves.toBe(false)

    expect(other()?.phase).toEqual({ kind: 'unloaded', reason: 'evicted', message: null })
  })

  it('an open blocked by a canvas that could not be saved shows the error in a panel and keeps no mount', async () => {
    open.mockResolvedValueOnce({
      success: false,
      error: 'could not unload the least recently active canvas (project proj-2) to make room',
      code: 'EVICTION_BLOCKED'
    })

    await expect(useCanvasStore.getState().openCanvas(PROJECT, DOC_A)).resolves.toBe(false)

    expect(session()?.phase).toEqual({
      kind: 'unloaded',
      reason: 'blocked',
      message: 'could not unload the least recently active canvas (project proj-2) to make room'
    })
    expect(canvasTabs()).toEqual([expect.objectContaining({ projectId: PROJECT })])
    expect(toastError).toHaveBeenCalled()

    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    expect(session()?.phase.kind).toBe('loading')
  })

  it('a visible report the host answers CANVAS_CLOSED unloads the canvas', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    setVisible.mockResolvedValueOnce({ success: false, error: 'gone', code: 'CANVAS_CLOSED' })

    await useCanvasStore.getState().setCanvasVisible(PROJECT, 41, true)

    expect(setVisible).toHaveBeenCalledWith(PROJECT, 41, true)
    expect(session()?.phase).toEqual({ kind: 'unloaded', reason: 'evicted', message: null })
  })

  it('a live mount, a hidden report and a stale mountSeq leave the session alone', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)

    setVisible.mockResolvedValueOnce({ success: true, data: undefined })
    await useCanvasStore.getState().setCanvasVisible(PROJECT, 41, true)
    setVisible.mockResolvedValueOnce({ success: false, error: 'gone', code: 'CANVAS_CLOSED' })
    await useCanvasStore.getState().setCanvasVisible(PROJECT, 41, false)
    setVisible.mockResolvedValueOnce({ success: false, error: 'gone', code: 'CANVAS_CLOSED' })
    await useCanvasStore.getState().setCanvasVisible(PROJECT, 7, true)
    setVisible.mockResolvedValueOnce({ success: false, error: 'offline', code: 'NETWORK_ERROR' })
    await useCanvasStore.getState().setCanvasVisible(PROJECT, 41, true)

    expect(session()?.phase.kind).toBe('loading')
  })
})
