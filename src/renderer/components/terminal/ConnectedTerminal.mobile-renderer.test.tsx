/**
 * Story 2 (mobile DOM-renderer default + terminal typography) regression
 * tests, mirroring the QA repro matrix:
 *
 * | Scenario                  | Expected                                            |
 * |---------------------------|-----------------------------------------------------|
 * | Mobile default (auto)     | DOM renderer active; boundary log records the flip  |
 * | Mobile + explicit webgl   | WebGL attempted (explicit intent honored)           |
 * | Desktop default (auto)    | WebGL loads exactly as before (no behavior change)  |
 * | Canvas migration          | persisted 'canvas' → 'dom' (existing behavior)      |
 * | Font default              | JetBrains Mono Variable stack (bundled, CAP-9)      |
 * | Mobile padding            | px-1.5 (not px-4) on the mobile web shell          |
 * | Existing stored font      | untouched (custom fontFamily passed through)       |
 *
 * Renderer plumbing notes:
 * - DEFAULT terminalRenderer is now 'auto' (settings.ts). The mobile web
 *   shell (browser, viewport <= 767px) resolves 'auto' → DOM in
 *   ConnectedTerminal; desktop resolves 'auto' → WebGL.
 * - The WebGL addon mock counts constructions — 0 means the DOM renderer
 *   path was taken, 1 means WebGL was loaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mutable refs — read by module mocks, set per test.
const { mobileRef, rendererRef, tauriRef, fontRef } = vi.hoisted(() => ({
  mobileRef: { current: false as boolean },
  rendererRef: { current: 'auto' as 'auto' | 'webgl' | 'dom' | 'canvas' },
  tauriRef: { current: false as boolean },
  fontRef: { current: 'monospace' as string }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767,
  resolveMobileWebShell: (isTauri: boolean, matches: boolean) => !isTauri && matches
}))

vi.mock('@/stores/app-settings-store', () => ({
  useTerminalFontFamily: () => fontRef.current,
  useTerminalFontSize: () => 14,
  useTerminalBufferSize: () => 10000,
  useTerminalRenderer: () => rendererRef.current
}))

// --- xterm + addon mocks (construction counters drive assertions) ---

let webglAddonCreateCount = 0
let terminalConstructorOptions: Record<string, unknown> | null = null

vi.mock('@xterm/xterm', async () => {
  const { vi: v } = await import('vitest')
  return {
    Terminal: class MockTerminal {
      loadAddon = v.fn()
      open = v.fn()
      attachCustomKeyEventHandler = v.fn()
      onData = v.fn(() => ({ dispose: v.fn() }))
      onResize = v.fn(() => ({ dispose: v.fn() }))
      onSelectionChange = v.fn(() => ({ dispose: v.fn() }))
      hasSelection = v.fn(() => false)
      getSelection = v.fn(() => '')
      selectAll = v.fn()
      paste = v.fn()
      write = v.fn()
      clear = v.fn()
      focus = v.fn()
      refresh = v.fn()
      scrollToLine = v.fn()
      dispose = v.fn()
      cols = 80
      rows = 24
      options = {}
      buffer = { active: { getLine: v.fn(() => ({ translateToString: () => '' })) } }
      element = document.createElement('div')
      registerLinkProvider = v.fn(() => ({ dispose: v.fn() }))
      constructor(options?: Record<string, unknown>) {
        terminalConstructorOptions = options ?? null
      }
    }
  }
})

vi.mock('@xterm/addon-fit', async () => {
  const { vi: v } = await import('vitest')
  return {
    FitAddon: class {
      fit = v.fn()
      dispose = v.fn()
    }
  }
})
vi.mock('@xterm/addon-search', async () => {
  const { vi: v } = await import('vitest')
  return {
    SearchAddon: class {
      findNext = v.fn()
      findPrevious = v.fn()
      clearDecorations = v.fn()
      dispose = v.fn()
    }
  }
})
vi.mock('@xterm/addon-webgl', () => {
  return {
    WebglAddon: class {
      onContextLoss = vi.fn()
      dispose = vi.fn()
      constructor() {
        webglAddonCreateCount++
      }
    }
  }
})
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose() {}
  }
}))

// --- API / lib mocks (same shape as ConnectedTerminal.contextmenu.test) ---

vi.mock('@/lib/api', async () => {
  const { vi: v } = await import('vitest')
  return {
    terminalApi: {
      spawn: v.fn().mockResolvedValue({
        success: true,
        data: { id: 'test-pty', shell: 'bash', cwd: '/' }
      }),
      write: v.fn().mockResolvedValue({ success: true }),
      resize: v.fn().mockResolvedValue({ success: true }),
      kill: v.fn().mockResolvedValue({ success: true }),
      onData: v.fn(() => () => {}),
      onExit: v.fn(() => () => {}),
      onCwdChanged: v.fn(() => () => {}),
      getCwd: v.fn()
    },
    systemApi: {
      getHomeDirectory: v.fn().mockResolvedValue({ success: true, data: '/home' }),
      onPowerResume: v.fn(() => () => {})
    },
    clipboardApi: {
      readText: v.fn().mockResolvedValue({ success: true, data: '' }),
      writeText: v.fn().mockResolvedValue({ success: true }),
      hasImage: v.fn().mockResolvedValue({ success: true, data: false })
    }
  }
})

// Story 2: the boundary log destination — asserting the mobile renderer
// flip is recorded durably (log-api, metadata only, never secrets).
const mockLogFrontendError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogFrontendError }))

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => tauriRef.current }
})

vi.mock('@/lib/tauri-terminal-api', async () => {
  const { vi: v } = await import('vitest')
  return {
    addRendererRef: v.fn().mockResolvedValue({ success: true }),
    removeRendererRef: v.fn().mockResolvedValue({ success: true })
  }
})

vi.mock('@/lib/terminal-continuity-instrumentation', async () => {
  const { vi: v } = await import('vitest')
  return {
    recordTerminalContinuityEvent: v.fn(),
    getOrCreateProjectContinuityCorrelation: v.fn(() => 'corr')
  }
})

vi.mock('@/lib/file-path-links', () => ({
  openFilePathFromTerminal: vi.fn().mockResolvedValue({ ok: true }),
  buildTerminalPathLinks: vi.fn(() => [])
}))
vi.mock('@/lib/terminal-url-links', () => ({
  buildTerminalUrlLinks: vi.fn(() => []),
  isSupportedTerminalUrl: vi.fn(() => false)
}))
vi.mock('@/lib/browser/terminal-url-navigation', () => ({ openTerminalUrl: vi.fn() }))
vi.mock('@/lib/themes', () => ({
  applyThemeToTerminal: vi.fn(),
  getActiveTerminalTheme: vi.fn(() => ({}))
}))

vi.mock('@/hooks/use-terminal-clipboard', async () => {
  const { vi: v } = await import('vitest')
  return {
    useTerminalClipboard: () => ({
      copySelection: v.fn(),
      pasteFromClipboard: v.fn(),
      hasSelection: false
    })
  }
})
vi.mock('@/hooks/use-terminal-color-theme', () => ({ useTerminalColorTheme: () => {} }))
vi.mock('@/hooks/use-terminal-resize-v2', async () => {
  const { vi: v } = await import('vitest')
  return { useTerminalResizeV2: () => ({ forceFit: v.fn() }) }
})
vi.mock('@/hooks/use-terminal-restore', async () => {
  const { vi: v } = await import('vitest')
  return { isTerminalPendingPtyAssignment: v.fn(() => false) }
})

vi.mock('@/stores/terminal-store', async () => {
  const { vi: v } = await import('vitest')
  const state = {
    terminals: [] as Array<{ id: string; healthStatus?: string }>,
    healthStatus: 'running',
    restartTerminal: v.fn(),
    setRendererAttached: v.fn(),
    findTerminalByPtyId: v.fn(),
    peekTranscript: v.fn(() => ''),
    consumeTranscript: v.fn(() => ''),
    updateTerminalActivityBatch: v.fn(),
    setTerminalClaim: v.fn(),
    setTerminalHealthStatus: v.fn()
  }
  const storeHook = v.fn((sel: (s: typeof state) => unknown) => sel(state))
  ;(storeHook as unknown as { getState: () => typeof state }).getState = () => state
  return { useTerminalStore: storeHook }
})
vi.mock('@/stores/project-store', () => ({ useActiveProject: () => ({ path: '/project' }) }))
vi.mock('@/stores/keyboard-shortcuts-store', async () => {
  const { vi: v } = await import('vitest')
  return {
    useKeyboardShortcutsStore: v.fn(() => ({ shortcuts: {} })),
    matchesShortcut: v.fn(() => false)
  }
})
vi.mock('@/stores/connection-status-store', () => ({
  useConnectionStatusStore: vi.fn((sel: (s: { terminalChannel: string }) => unknown) =>
    sel({ terminalChannel: 'connected' })
  )
}))
vi.mock('@/stores/acp-store', () => ({ useAcpStore: vi.fn(() => ({})) }))
vi.mock('@/components/chat/AgentConnectionLamp', () => ({
  AgentConnectionLamp: () => null
}))
vi.mock('@/lib/web-terminal-api', () => ({
  isWebTerminalBufferable: vi.fn(() => true),
  setWebTerminalConnectionStateListener: vi.fn()
}))
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const wrap = (props: { children?: React.ReactNode }) =>
    React.createElement('div', null, props.children)
  return {
    ContextMenu: wrap,
    ContextMenuTrigger: wrap,
    ContextMenuContent: wrap,
    ContextMenuItem: wrap,
    ContextMenuSeparator: () => null,
    ContextMenuShortcut: (props: { children?: React.ReactNode }) =>
      React.createElement('span', null, props.children)
  }
})

vi.mock('../../utils/terminal-registry', () => ({
  buildRehydrateSequences: vi.fn(() => ''),
  captureScrollPosition: vi.fn(),
  registerTerminal: vi.fn(),
  restoreScrollback: vfnReturnsArray(),
  restoreScrollPosition: vfnReturnsArray(),
  unregisterTerminal: vi.fn()
}))
function vfnReturnsArray() {
  return vi.fn(() => [] as unknown[])
}
vi.mock('./terminal-cache', () => ({
  cacheTerminal: vi.fn(),
  takeCachedTerminal: vi.fn(() => undefined)
}))
vi.mock('./TerminalAssistPanel', () => ({
  TerminalAssistPanel: () => null
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { DEFAULT_TERMINAL_OPTIONS } from './terminal-config'
import { type RendererPreference, shouldUseWebglRenderer } from './terminal-factory'

const { render, cleanup } = await import('@testing-library/react')
const React = await import('react')
const { ConnectedTerminal } = await import('./ConnectedTerminal')

beforeEach(() => {
  webglAddonCreateCount = 0
  terminalConstructorOptions = null
  mockLogFrontendError.mockClear()
  mobileRef.current = false
  rendererRef.current = 'auto'
  tauriRef.current = false
  fontRef.current = 'monospace'
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Pure resolution-unit tests (no React render)
// ---------------------------------------------------------------------------

describe('shouldUseWebglRenderer (unified factory helper, story 2)', () => {
  it.each([
    ['auto', false, true],
    ['auto', true, false],
    ['webgl', false, true],
    ['webgl', true, true],
    ['dom', false, false],
    ['dom', true, false]
  ] as Array<
    [RendererPreference, boolean, boolean]
  >)('preference %s on mobile shell=%s → WebGL used: %s', (preference, isMobileWebShell, expectWebgl) => {
    expect(shouldUseWebglRenderer(preference, isMobileWebShell)).toBe(expectWebgl)
  })
})

// ---------------------------------------------------------------------------
// Matrix row 1: mobile default → DOM + boundary log
// Matrix row 2: mobile + explicit webgl → WebGL
// Matrix row 3: desktop default → WebGL (unchanged)
// ---------------------------------------------------------------------------

describe('ConnectedTerminal renderer resolution (QA repro matrix)', () => {
  it('mobile web shell + default (auto): DOM renderer active, boundary log records flip', async () => {
    mobileRef.current = true
    rendererRef.current = 'auto'

    render(React.createElement(ConnectedTerminal))

    // DOM renderer: the WebGL addon must never be constructed.
    await vi.waitFor(() => {
      expect(webglAddonCreateCount).toBe(0)
    })

    // Boundary log: exactly one durable line for the auto→dom flip.
    await vi.waitFor(() => {
      expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    })
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'ConnectedTerminal.rendererResolution'
      })
    )
  })

  it('mobile web shell + explicit webgl: WebGL attempted (explicit intent honored)', async () => {
    mobileRef.current = true
    rendererRef.current = 'webgl'

    render(React.createElement(ConnectedTerminal))

    await vi.waitFor(() => {
      expect(webglAddonCreateCount).toBe(1)
    })
    // No flip happened — no boundary log.
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })

  it('mobile web shell + explicit dom: DOM renderer, no flip log (already dom)', async () => {
    mobileRef.current = true
    rendererRef.current = 'dom'

    render(React.createElement(ConnectedTerminal))

    await vi.waitFor(() => {
      expect(webglAddonCreateCount).toBe(0)
    })
    // 'dom' is not the auto-default flip — nothing to log.
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })

  it('desktop (viewport >= 768px, browser): default auto → WebGL, exactly as before', async () => {
    mobileRef.current = false
    rendererRef.current = 'auto'

    render(React.createElement(ConnectedTerminal))

    await vi.waitFor(() => {
      expect(webglAddonCreateCount).toBe(1)
    })
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })

  it('desktop + explicit webgl: WebGL loads (pre-existing behavior)', async () => {
    mobileRef.current = false
    rendererRef.current = 'webgl'

    render(React.createElement(ConnectedTerminal))

    await vi.waitFor(() => {
      expect(webglAddonCreateCount).toBe(1)
    })
  })

  it('boundary log fires once per terminal instance (not per render)', async () => {
    mobileRef.current = true
    rendererRef.current = 'auto'

    const { rerender } = render(React.createElement(ConnectedTerminal))

    await vi.waitFor(() => {
      expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    })

    // Re-render with identical inputs — the once-per-instance guard holds.
    rerender(React.createElement(ConnectedTerminal, { className: 'again' }))
    rerender(React.createElement(ConnectedTerminal, { className: 'again-2' }))

    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Matrix row 6: mobile padding — px-1.5 instead of px-4 on the shell
// ---------------------------------------------------------------------------

describe('ConnectedTerminal container padding (story 2)', () => {
  it('mobile web shell: horizontal padding is px-1.5 (6px < 16px/side), not px-4', () => {
    mobileRef.current = true

    const { container } = render(React.createElement(ConnectedTerminal))

    const padded = container.querySelector('div.bg-terminal-bg')
    expect(padded).toBeTruthy()
    expect(padded?.className).toContain('px-1.5')
    expect(padded?.className).not.toContain('px-4')
  })

  it('desktop: horizontal padding stays px-4 (unchanged)', () => {
    mobileRef.current = false

    const { container } = render(React.createElement(ConnectedTerminal))

    const padded = container.querySelector('div.bg-terminal-bg')
    expect(padded).toBeTruthy()
    expect(padded?.className).toContain('px-4')
    expect(padded?.className).not.toContain('px-1.5')
  })
})

// ---------------------------------------------------------------------------
// Matrix row 5: font default = bundled JetBrains Mono Variable stack
// Matrix row 7: existing stored font preserved
// ---------------------------------------------------------------------------

describe('terminal font defaults (story 2 typography)', () => {
  it('DEFAULT_APP_SETTINGS.terminalFontFamily is the bundled JetBrains Mono stack', () => {
    // The settings default must match the canonical stack in
    // terminal-config.ts (terminal-config.ts:17-18), so a fresh profile
    // resolves to the bundled webfont that exists on mobile (CAP-9).
    expect(DEFAULT_APP_SETTINGS.terminalFontFamily).toContain('JetBrains Mono Variable')
    expect(DEFAULT_APP_SETTINGS.terminalFontFamily).toBe(DEFAULT_TERMINAL_OPTIONS.fontFamily)
  })

  it('DEFAULT_APP_SETTINGS.terminalRenderer is auto (mobile flip is resolution-time)', () => {
    // Default changed 'webgl' → 'auto': desktop resolves auto → WebGL
    // (unchanged behavior), mobile web shell resolves auto → DOM stopgap.
    expect(DEFAULT_APP_SETTINGS.terminalRenderer).toBe('auto')
  })

  it('font default is NOT the old Menlo/Monaco/Courier stack', () => {
    expect(DEFAULT_APP_SETTINGS.terminalFontFamily).not.toBe(
      'Menlo, Monaco, "Courier New", monospace'
    )
  })

  it('existing stored font preference is passed through to the Terminal options', () => {
    fontRef.current = 'Fira Code, monospace'

    render(React.createElement(ConnectedTerminal))

    // The user's persisted font reaches the xterm constructor verbatim.
    expect(terminalConstructorOptions).toMatchObject({
      fontFamily: 'Fira Code, monospace'
    })
  })

  it('font size default stays 14 (no size change in this story)', () => {
    expect(DEFAULT_APP_SETTINGS.terminalFontSize).toBe(14)
    expect(DEFAULT_TERMINAL_OPTIONS.fontSize).toBe(14)
  })
})

// ---------------------------------------------------------------------------
// Matrix row 4: canvas migration intact (settings-load path)
// ---------------------------------------------------------------------------

describe('canvas renderer migration contract (row 4, unchanged)', () => {
  it("legacy persisted 'canvas' never reaches the renderer guards (migrated at load)", async () => {
    // The loader (use-app-settings.ts) migrates persisted 'canvas' → 'dom'
    // before ConnectedTerminal reads it. If that migration ever regresses,
    // 'canvas' would flow through as an unknown preference — this test pins
    // the terminal-side contract: anything that is not 'auto'/'webgl' must
    // NOT trigger WebGL when the mobile flip would not apply.
    // (The loader's own migration is covered in use-app-settings.test.ts.)
    // Here: verify 'dom' (the migration target) keeps WebGL off everywhere.
    mobileRef.current = false
    rendererRef.current = 'dom'

    render(React.createElement(ConnectedTerminal))

    await vi.waitFor(() => {
      expect(webglAddonCreateCount).toBe(0)
    })
  })
})
