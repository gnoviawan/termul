import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as appSettingsStore from '@/stores/app-settings-store'

// Story 3 (WebGL high-DPR root fix) — regression tests mirroring the QA repros
// as closely as jsdom permits:
//   Matrix row 1: high-DPR (3) init executes the correct sizing calls
//   Matrix row 2: DPR change mid-session re-syncs the WebGL canvas
//   Matrix row 4: dom preference never loads the addon
//   Matrix row 5: DPR 1 default — no extra re-init churn
// jsdom has no WebGL: the WebglAddon is module-mocked (same convention as
// ConnectedTerminal.test.tsx) and assertions target OUR seam — the
// renderService.handleDevicePixelRatioChange re-sync call, refresh, addon
// re-init (dispose + reload), and the log-api failure entries.

// Mock Tauri APIs BEFORE importing the component
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
  emit: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() =>
    Promise.resolve({
      id: 'terminal-123',
      shell: 'bash',
      cwd: '/home/user'
    })
  )
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

const mockIsTauriContext = vi.hoisted(() => vi.fn(() => false))
vi.mock('@/lib/tauri-runtime', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, isTauriContext: mockIsTauriContext }
})

const mockLogFrontendError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogFrontendError }))
// Hoisted so the hoisted vi.mock('@/lib/api') factory can reference it —
// vi.mock calls are lifted above every plain const in the file.
const mockTerminalApi = vi.hoisted(() => ({
  spawn: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn()),
  onCwdChanged: vi.fn(),
  getCwd: vi.fn()
}))
const mockTerminalConstructor = vi.fn()
// Story 3: the dimensions re-sync drives the core render service's
// handleDevicePixelRatioChange — the exact hook xterm's own DPR-change flow
// uses. Capture its invocation to assert the sizing path ran.
const mockRenderServiceHandleDprChange = vi.fn()
const mockTerminalInstance = {
  loadAddon: vi.fn(),
  registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
  open: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onResize: vi.fn(() => ({ dispose: vi.fn() })),
  onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
  attachCustomKeyEventHandler: vi.fn(),
  hasSelection: vi.fn(() => false),
  getSelection: vi.fn(() => ''),
  selectAll: vi.fn(),
  paste: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  focus: vi.fn(),
  refresh: vi.fn(),
  scrollToLine: vi.fn(),
  dispose: vi.fn(),
  cols: 80,
  rows: 24,
  options: {} as Record<string, unknown>,
  buffer: {
    active: {
      getLine: vi.fn(() => ({
        translateToString: () => ''
      }))
    }
  },
  element: (typeof document !== 'undefined' ? document.createElement('div') : undefined) as
    | HTMLDivElement
    | undefined,
  // Story 3: expose the private core seam the component feature-detects.
  _core: {
    _renderService: {
      handleDevicePixelRatioChange: mockRenderServiceHandleDprChange
    }
  }
}

const mockFitAddonInstance = {
  fit: vi.fn(),
  dispose: vi.fn()
}

// Track WebGL addon instances for re-init assertions
let webglAddonCreateCount = 0
let capturedContextLossCallback: (() => void) | null = null
let lastCreatedWebglInstance: {
  dispose: ReturnType<typeof vi.fn>
  onContextLoss: ReturnType<typeof vi.fn>
} | null = null

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    constructor(options?: Record<string, unknown>) {
      mockTerminalConstructor(options)
    }
    loadAddon = mockTerminalInstance.loadAddon
    registerLinkProvider = mockTerminalInstance.registerLinkProvider
    open = mockTerminalInstance.open
    onData = mockTerminalInstance.onData
    onResize = mockTerminalInstance.onResize
    onSelectionChange = mockTerminalInstance.onSelectionChange
    attachCustomKeyEventHandler = mockTerminalInstance.attachCustomKeyEventHandler
    hasSelection = mockTerminalInstance.hasSelection
    getSelection = mockTerminalInstance.getSelection
    selectAll = mockTerminalInstance.selectAll
    paste = mockTerminalInstance.paste
    write = mockTerminalInstance.write
    clear = mockTerminalInstance.clear
    focus = mockTerminalInstance.focus
    refresh = mockTerminalInstance.refresh
    scrollToLine = mockTerminalInstance.scrollToLine
    dispose = mockTerminalInstance.dispose
    cols = mockTerminalInstance.cols
    rows = mockTerminalInstance.rows
    options = mockTerminalInstance.options
    buffer = mockTerminalInstance.buffer
    element = mockTerminalInstance.element
    _core = mockTerminalInstance._core
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = mockFitAddonInstance.fit
    dispose = mockFitAddonInstance.dispose
  }
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class MockWebglAddon {
    dispose = vi.fn()
    onContextLoss = vi.fn((cb: () => void) => {
      capturedContextLossCallback = cb
    })
    constructor() {
      webglAddonCreateCount++
      lastCreatedWebglInstance = {
        dispose: this.dispose,
        onContextLoss: this.onContextLoss
      }
    }
  }
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProject: vi.fn(() => ({ path: '/project-root' })),
  useProjects: vi.fn(() => []),
  useActiveProjectId: vi.fn(() => 'project-a')
}))

vi.mock('@/lib/api', () => ({
  terminalApi: mockTerminalApi,
  systemApi: {
    getHomeDirectory: vi.fn(),
    onPowerResume: vi.fn(() => vi.fn())
  },
  clipboardApi: {
    readText: vi.fn(),
    writeText: vi.fn(),
    hasImage: vi.fn(() => Promise.resolve({ success: true, data: false }))
  }
}))

vi.mock('@/stores/app-settings-store', () => ({
  useTerminalFontFamily: vi.fn(() => 'JetBrains Mono, monospace'),
  useTerminalFontSize: vi.fn(() => 14),
  useTerminalBufferSize: vi.fn(() => 10000),
  useTerminalRenderer: vi.fn(() => 'auto')
}))

// The vi.mock factory below replaces this module's exports; importing the
// namespace lets tests hot-swap the mock WebglAddon constructor (failure
// injection) while the component resolves it through the same binding.
import * as webglAddonModule from '@xterm/addon-webgl'
import { useTerminalRenderer } from '@/stores/app-settings-store'
import { ConnectedTerminal } from './ConnectedTerminal'

const mockTerminalStoreState = {
  terminals: [] as Array<{ id: string; ptyId?: string; healthStatus?: string }>,
  activeTerminalId: '',
  selectTerminal: vi.fn(),
  addTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  renameTerminal: vi.fn(),
  reorderTerminals: vi.fn(),
  setTerminals: vi.fn(),
  setTerminalPtyId: vi.fn(),
  setTerminalClaim: vi.fn(),
  findTerminalByPtyId: vi.fn(),
  updateTerminalCwd: vi.fn(),
  updateTerminalGitBranch: vi.fn(),
  updateTerminalGitStatus: vi.fn(),
  updateTerminalExitCode: vi.fn(),
  updateTerminalScrollback: vi.fn(),
  appendTranscript: vi.fn(),
  peekTranscript: vi.fn(() => ''),
  consumeTranscript: vi.fn(() => ''),
  appendDetachedOutput: vi.fn(),
  consumeDetachedOutput: vi.fn(() => ''),
  setRendererAttached: vi.fn(),
  setTerminalHealthStatus: vi.fn(),
  setTerminalHidden: vi.fn(),
  updateTerminalActivity: vi.fn(),
  updateTerminalLastActivityTimestamp: vi.fn(),
  updateTerminalActivityBatch: vi.fn(),
  restartTerminal: vi.fn(),
  clearTerminalPtyId: vi.fn(),
  truncateHiddenTerminalBuffers: vi.fn(),
  getTerminalCount: vi.fn(() => 0),
  isTerminalLimitReached: vi.fn(() => false),
  cleanupProjectTerminals: vi.fn()
}

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: Object.assign(
    vi.fn((selector) => selector(mockTerminalStoreState)),
    { getState: () => mockTerminalStoreState }
  )
}))

vi.mock('@/lib/tauri-terminal-api', () => ({
  addRendererRef: vi.fn().mockResolvedValue({ success: true, data: undefined }),
  removeRendererRef: vi.fn().mockResolvedValue({ success: true, data: undefined })
}))

const mockRecordTerminalContinuityEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/terminal-continuity-instrumentation', () => ({
  recordTerminalContinuityEvent: mockRecordTerminalContinuityEvent,
  getOrCreateProjectContinuityCorrelation: vi.fn(() => 'corr-project-a')
}))

vi.mock('@/hooks/use-terminal-restore', () => ({
  isTerminalPendingPtyAssignment: vi.fn(() => false)
}))

vi.mock('@/lib/file-path-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/file-path-links')>()
  return {
    ...actual,
    openFilePathFromTerminal: vi.fn()
  }
})

/** Captive matchMedia double: hands out MediaQueryLists we can fire. */
interface CaptiveMediaQueryList {
  media: string
  matches: boolean
  onchange: null
  addListener: vi.Mock
  removeListener: vi.Mock
  addEventListener: vi.Mock
  removeEventListener: vi.Mock
  dispatchEvent: vi.Mock
  listeners: Set<() => void>
}

function createCaptiveMediaQueryList(media: string): CaptiveMediaQueryList {
  const listeners = new Set<() => void>()
  return {
    media,
    matches: false,
    onchange: null,
    addListener: vi.fn((cb: () => void) => listeners.add(cb)),
    removeListener: vi.fn((cb: () => void) => listeners.delete(cb)),
    addEventListener: vi.fn((_type: string, cb: () => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_type: string, cb: () => void) => listeners.delete(cb)),
    dispatchEvent: vi.fn(() => false),
    listeners
  }
}

function fireCaptiveChange(mql: CaptiveMediaQueryList): void {
  for (const listener of mql.listeners) {
    listener()
  }
}

describe('ConnectedTerminal WebGL high-DPR root fix (story 3)', () => {
  let rendererPreferenceSpy: ReturnType<typeof vi.spyOn>
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>
  let originalDpr: number | undefined
  let mediaQueryLists: CaptiveMediaQueryList[]
  let originalMatchMedia: typeof window.matchMedia

  beforeEach(() => {
    vi.clearAllMocks()
    mockLogFrontendError.mockReset()
    rendererPreferenceSpy = vi
      .spyOn(appSettingsStore, 'useTerminalRenderer')
      .mockReturnValue('webgl')
    webglAddonCreateCount = 0
    capturedContextLossCallback = null
    lastCreatedWebglInstance = null
    mockTerminalApi.spawn.mockResolvedValue({
      success: true,
      data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
    })
    mockTerminalApi.write.mockResolvedValue({ success: true, data: undefined })
    mockTerminalApi.resize.mockResolvedValue({ success: true, data: undefined })
    mockTerminalStoreState.findTerminalByPtyId.mockReturnValue({ cwd: '/terminal-cwd' })

    global.ResizeObserver = class MockResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as unknown as typeof ResizeObserver

    getBoundingClientRectSpy = vi
      .spyOn(HTMLDivElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        width: 342,
        height: 722,
        top: 0,
        left: 0,
        bottom: 722,
        right: 342,
        x: 0,
        y: 0,
        toJSON: () => {}
      } as DOMRect)

    // jsdom defaults to DPR 1. Remember and restore per test.
    originalDpr = window.devicePixelRatio
    mediaQueryLists = []
    originalMatchMedia = window.matchMedia
  })

  afterEach(() => {
    getBoundingClientRectSpy.mockRestore()
    rendererPreferenceSpy.mockRestore()
    cleanup()
    // Restore DPR and matchMedia so sibling describe blocks in this file (and
    // later files in the worker) see the pristine jsdom environment.
    Object.defineProperty(window, 'devicePixelRatio', {
      writable: true,
      configurable: true,
      value: originalDpr ?? 1
    })
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia
    })
    for (const mql of mediaQueryLists) {
      mql.listeners.clear()
    }
    mediaQueryLists = []
  })

  const installCaptiveMatchMedia = (dpr: number): CaptiveMediaQueryList => {
    const mql = createCaptiveMediaQueryList(`(resolution: ${dpr}dppx)`)
    mediaQueryLists.push(mql)
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn((query: string) => {
        if (query === `(resolution: ${dpr}dppx)`) return mql
        // Any other query (e.g. mobile-shell viewport checks) gets a stub.
        return createCaptiveMediaQueryList(query)
      })
    })
    return mql
  }

  const setDevicePixelRatio = (dpr: number): void => {
    Object.defineProperty(window, 'devicePixelRatio', {
      writable: true,
      configurable: true,
      value: dpr
    })
  }

  const waitForSpawn = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(mockTerminalApi.spawn).toHaveBeenCalled()
    })
    // Let the RAF-deferred initial fit flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  describe('matrix row 1 — high-DPR (3) init executes the sizing path', () => {
    it('re-syncs renderer dimensions at the current devicePixelRatio right after addon load', async () => {
      setDevicePixelRatio(3)
      const mql = installCaptiveMatchMedia(3)

      render(<ConnectedTerminal />)
      await waitForSpawn()

      // The addon was created and activated at DPR 3...
      expect(webglAddonCreateCount).toBe(1)
      // ...and the dimensions re-sync drove the core's DPR-change hook —
      // the sizing path that rebuilds renderer dimensions + texture atlas.
      expect(mockRenderServiceHandleDprChange).toHaveBeenCalled()
      expect(mockTerminalInstance.refresh).toHaveBeenCalledWith(0, 23)
      // The DPR watch armed at the CURRENT dpr (not a stale 0/1).
      expect(mql.media).toBe('(resolution: 3dppx)')
    })

    it('logs a durable failure entry when the dimensions re-sync throws', async () => {
      setDevicePixelRatio(3)
      installCaptiveMatchMedia(3)
      mockRenderServiceHandleDprChange.mockImplementationOnce(() => {
        throw new Error('dimensions desync')
      })

      render(<ConnectedTerminal />)
      await waitForSpawn()

      // The addon still loaded; only the re-sync failed.
      expect(webglAddonCreateCount).toBe(1)
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          source: 'ConnectedTerminal.loadWebglAddon',
          message: expect.stringContaining('dimensions re-sync failed')
        })
      )
      // Context (dpr, css size, addon) is embedded in the durable message —
      // metadata only, never secrets.
      const call = mockLogFrontendError.mock.calls.find(([payload]) =>
        String((payload as { message?: string }).message ?? '').includes('re-sync failed')
      )
      const loggedMessage = (call?.[0] as { message?: string }).message ?? ''
      expect(loggedMessage).toContain('dpr=3')
      expect(loggedMessage).toContain('addon=@xterm/addon-webgl')
      expect(loggedMessage).toContain('css=')
    })
  })

  describe('matrix row 2 — DPR change mid-session re-syncs the canvas', () => {
    it('disposes and reloads the WebGL addon when DPR changes 1->3', async () => {
      // Boot at DPR 1 (desktop default).
      setDevicePixelRatio(1)
      const mql1 = installCaptiveMatchMedia(1)

      render(<ConnectedTerminal />)
      await waitForSpawn()
      expect(webglAddonCreateCount).toBe(1)
      const firstInstance = lastCreatedWebglInstance
      expect(firstInstance?.dispose).not.toHaveBeenCalled()

      // DPR change 1 -> 3 (zoom in / phone rotation): the browser drops the
      // old matchMedia query and fires the change event on it.
      setDevicePixelRatio(3)
      act(() => {
        fireCaptiveChange(mql1)
      })

      // The stale addon was disposed...
      expect(firstInstance?.dispose).toHaveBeenCalled()
      // ...and a fresh addon was created and re-synced at the NEW dpr.
      expect(webglAddonCreateCount).toBe(2)
      expect(mockRenderServiceHandleDprChange).toHaveBeenCalled()
    })

    it('logs a failure entry when the re-init after a DPR change fails', async () => {
      setDevicePixelRatio(1)
      const mql1 = installCaptiveMatchMedia(1)

      // First load succeeds.
      render(<ConnectedTerminal />)
      await waitForSpawn()
      expect(webglAddonCreateCount).toBe(1)

      // Make every subsequent construction throw (WebGL fails at this dpr).
      // Static import of the module-mocked namespace (test double swap —
      // dynamic import unnecessary since the specifier is fixed).
      const addonModuleWritable = webglAddonModule as { WebglAddon: unknown }
      const originalCtor = webglAddonModule.WebglAddon
      addonModuleWritable.WebglAddon = class ThrowingAddon {
        constructor() {
          webglAddonCreateCount++
          throw new Error('WebGL2 not supported at dpr 3')
        }
      }

      setDevicePixelRatio(3)
      act(() => {
        fireCaptiveChange(mql1)
      })

      // Old addon disposed, reload attempted (and threw)...
      expect(webglAddonCreateCount).toBe(2)
      // ...terminal stays alive on the DOM renderer, failure logged durably.
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          source: 'ConnectedTerminal.dprChange',
          message: expect.stringContaining('devicePixelRatio change 1 -> 3')
        })
      )

      // Restore the mock constructor for subsequent tests.
      addonModuleWritable.WebglAddon = originalCtor
    })
  })

  describe('matrix row 4 — dom preference never loads the addon', () => {
    it('loads no WebGL addon and registers no DPR matchMedia listener', async () => {
      setDevicePixelRatio(3)
      installCaptiveMatchMedia(3)
      vi.mocked(useTerminalRenderer).mockReturnValue('dom')

      render(<ConnectedTerminal />)
      await waitForSpawn()

      expect(webglAddonCreateCount).toBe(0)
      expect(mockRenderServiceHandleDprChange).not.toHaveBeenCalled()
      // No resolution query was subscribed: the captive mql for dppx 3 stays
      // listener-free.
      expect(mediaQueryLists[0].listeners.size).toBe(0)
      expect(mediaQueryLists[0].addEventListener).not.toHaveBeenCalled()
    })
  })

  describe('matrix row 5 — desktop DPR 1 unchanged', () => {
    it('does not re-init the addon while DPR stays 1 (no churn)', async () => {
      setDevicePixelRatio(1)
      const mql1 = installCaptiveMatchMedia(1)

      render(<ConnectedTerminal />)
      await waitForSpawn()
      expect(webglAddonCreateCount).toBe(1)

      // Spurious change events at the SAME dpr must not churn the addon.
      act(() => {
        fireCaptiveChange(mql1)
        fireCaptiveChange(mql1)
      })

      expect(webglAddonCreateCount).toBe(1)
      expect(lastCreatedWebglInstance?.dispose).not.toHaveBeenCalled()
    })
  })
})
