/**
 * F4: Locks the macOS-shortcut bug fix in ConnectedTerminal.
 *
 * `SHORTCUT_MOD` (ConnectedTerminal.tsx:128) is a module-level const computed
 * from `isMac` at import time: `isMac ? '⌘' : 'Ctrl'`. The context menu
 * renders `<ContextMenuShortcut>{SHORTCUT_MOD}+C/V/A</ContextMenuShortcut>`
 * (L1870/1873/1877). This test verifies the rendered shortcut text is
 * platform-correct: `⌘+C/V/A` on macOS, `Ctrl+C/V/A` elsewhere.
 *
 * Because `SHORTCUT_MOD` is evaluated once at module load, each test uses
 * `vi.resetModules()` + dynamic `import()` so the module re-evaluates with
 * the current `isMac` value. Both `@testing-library/react` and
 * `ConnectedTerminal` are dynamically imported together so they share the
 * same (re-imported) React instance — avoiding "Invalid hook call" errors.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

// Controllable isMac — a hoisted ref read by the mock's getter. Setting
// `.current` before `vi.resetModules()` + dynamic import controls the value
// `SHORTCUT_MOD` is computed from.
const { isMacRef } = vi.hoisted(() => ({ isMacRef: { current: false } }))

vi.mock('@/lib/platform', () => ({
  get isMac() {
    return isMacRef.current
  },
  isPlatformModifier: (e: KeyboardEvent) => (isMacRef.current ? e.metaKey : e.ctrlKey),
  isWindows: false,
  isLinux: false,
  getPlatformModifier: () => (isMacRef.current ? 'cmd' : 'ctrl'),
  isSecondaryModifier: (e: KeyboardEvent) => (isMacRef.current ? e.ctrlKey : e.metaKey),
  macOsTitlebarStripClass: 'h-8 shrink-0 bg-background flex items-center relative'
}))

// Inline (always-visible) context-menu stub so the shortcut text is queryable
// without opening the menu (F4 is about the shortcut TEXT, not open behavior).
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

// --- Stable dep mocks (re-evaluated after vi.resetModules()) ---

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
    }
  }
})

vi.mock('@xterm/addon-fit', async () => {
  const { vi: v } = await import('vitest')
  return { FitAddon: class { fit = v.fn(); dispose = v.fn() } }
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
vi.mock('@xterm/addon-webgl', async () => {
  const { vi: v } = await import('vitest')
  return { WebglAddon: class { onContextLoss = v.fn(); dispose = v.fn() } }
})
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose() {}
  }
}))

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
      onExit: v.fn(() => () => {})
    },
    systemApi: {
      getHomeDirectory: v.fn().mockResolvedValue({ success: true, data: '/home' }),
      onPowerResume: v.fn(() => () => {})
    },
    clipboardApi: {
      readText: v.fn().mockResolvedValue({ success: true, data: '' }),
      writeText: v.fn().mockResolvedValue({ success: true })
    }
  }
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

vi.mock('@/stores/app-settings-store', () => ({
  useTerminalFontFamily: () => 'monospace',
  useTerminalFontSize: () => 14,
  useTerminalBufferSize: () => 10000,
  useTerminalRenderer: () => 'auto'
}))
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
  // The component calls `useTerminalStore.getState()` during effect cleanup
  // (unmount), so the mock hook must expose `getState` too.
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

vi.mock('../../utils/terminal-registry', () => ({
  buildRehydrateSequences: vi.fn(() => ''),
  captureScrollPosition: vi.fn(),
  registerTerminal: vi.fn(),
  restoreScrollback: vi.fn(),
  restoreScrollPosition: vi.fn(),
  unregisterTerminal: vi.fn()
}))
vi.mock('./terminal-cache', () => ({
  cacheTerminal: vi.fn(),
  takeCachedTerminal: vi.fn(() => undefined)
}))
vi.mock('./terminal-config', () => ({ getTerminalOptions: vi.fn(() => ({})) }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

let cleanupFn: (() => void) | null = null

afterEach(() => {
  cleanupFn?.()
  cleanupFn = null
})

describe('ConnectedTerminal context menu shortcuts (F4)', () => {
  it('shows ⌘+C / ⌘+V / ⌘+A on macOS', async () => {
    isMacRef.current = true
    vi.resetModules()
    const React = await import('react')
    const { render, screen, cleanup } = await import('@testing-library/react')
    cleanupFn = cleanup
    const { ConnectedTerminal } = await import('./ConnectedTerminal')

    render(React.createElement(ConnectedTerminal))

    expect(screen.getByText('⌘+C')).toBeInTheDocument()
    expect(screen.getByText('⌘+V')).toBeInTheDocument()
    expect(screen.getByText('⌘+A')).toBeInTheDocument()
  })

  it('shows Ctrl+C / Ctrl+V / Ctrl+A on non-macOS', async () => {
    isMacRef.current = false
    vi.resetModules()
    const React = await import('react')
    const { render, screen, cleanup } = await import('@testing-library/react')
    cleanupFn = cleanup
    const { ConnectedTerminal } = await import('./ConnectedTerminal')

    render(React.createElement(ConnectedTerminal))

    expect(screen.getByText('Ctrl+C')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+V')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+A')).toBeInTheDocument()
  })
})
