/**
 * Canvas store: the open/close lifecycle against a mocked facade and the
 * mount and persistence flows against a real bridge talking to a fake editor
 * window, with the real workspace store for the singleton tab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  open,
  close,
  readDocument,
  documentLoaded,
  dirtyChanged,
  writeSnapshot,
  toastError,
  logFrontendError
} = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  readDocument: vi.fn(),
  documentLoaded: vi.fn(),
  dirtyChanged: vi.fn(),
  writeSnapshot: vi.fn(),
  toastError: vi.fn(),
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/canvas-api', () => ({
  canvasApi: { open, close, readDocument, documentLoaded, dirtyChanged, writeSnapshot }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError }))
vi.mock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(), success: vi.fn(), warning: vi.fn() }
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
import { type CanvasMount, pinVerdict, useCanvasStore } from '../canvas-store'
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
  mountSeq: 41
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

    expect(open).toHaveBeenCalledWith(DOC_A, PROJECT, 1500)
    expect(session()?.phase.kind).toBe('loading')
    expect(currentMount()).toEqual({ mountSeq: 41, info: INFO })
    expect(canvasTabs()).toEqual([
      expect.objectContaining({ id: `canvas-${PROJECT}`, projectId: PROJECT, docPath: DOC_A })
    ])
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
    expect(close).toHaveBeenCalledWith(PROJECT, false)
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
  })

  it('an unmount the host ran drops the session: pending calls resolve CANVAS_CLOSED', async () => {
    open.mockResolvedValueOnce(openInfo())
    await useCanvasStore.getState().openCanvas(PROJECT, DOC_A)
    mountEditor()
    const pending = useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')

    await useCanvasStore.getState().unmountCanvas(PROJECT)

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
    expect(close).toHaveBeenCalledWith(PROJECT, false)
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
    expect(close).toHaveBeenLastCalledWith(PROJECT, true)
    expect(session()).toBeUndefined()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
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

  it('a document that does not exist yet starts empty: no host.openDocument, null ack', async () => {
    const editor = await mountReady(null)
    expect(editor.sent('host.openDocument')).toHaveLength(0)
    expect(documentLoaded).toHaveBeenCalledWith(PROJECT, 41, null)
    expect(session()?.phase.kind).toBe('ready')
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

  it('an editor crash fails the mount', () => {
    const editor = mountEditor()
    editor.ready()
    editor.send({ method: 'event.crashed', params: '{"reason":"panic"}', mountSeq: 41 })
    expect(session()?.phase).toMatchObject({ kind: 'failed', code: 'EDITOR_CRASHED' })
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

describe('pinVerdict', () => {
  it('matches only the exact pinned tag and refuses only in release', () => {
    expect(pinVerdict('termul-v1', 'termul-v1', true)).toBe('match')
    expect(pinVerdict('dev', 'termul-v1', false)).toBe('mismatch-logged')
    expect(pinVerdict('dev', 'termul-v1', true)).toBe('mismatch-refused')
    expect(pinVerdict(null, 'termul-v1', true)).toBe('mismatch-refused')
  })
})
