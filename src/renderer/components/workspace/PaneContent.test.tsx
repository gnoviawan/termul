import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import type { LeafNode } from '@/types/workspace.types'

// CAP-6 Row 3: EditorPanel is React.lazy in PaneContent.tsx — when an editor
// pane opens, <Suspense fallback={<PaneSkeleton/>}> shows a skeleton until the
// lazy chunk resolves, then the editor renders. This test verifies the
// lazy+Suspense mechanism resolves and renders EditorPanel with the correct
// filePath prop. EditorPanel is stubbed so real CodeMirror/BlockNote don't
// load in jsdom — the point is to verify the lazy boundary, not editor internals.
//
// CAP-6 Patch 4: The error-path test simulates a chunk-load failure by making
// the EditorPanel mock throw, then asserts the ErrorBoundary surfaces the error
// and calls logFrontendError (per the spec's "If the chunk fails to load, the
// Suspense boundary surfaces the error via log-api.ts"). The existing
// ErrorBoundary already calls logFrontendError — no per-pane wrapper needed.

const { editorMock } = vi.hoisted(() => ({
  editorMock: vi.fn()
}))

vi.mock('@/components/editor/EditorPanel', () => ({
  EditorPanel: editorMock
}))

// Mutable per-test counter: how many AgentChatPanel instances have mounted
// (identity check for the remap-continuity tests below).
const { chatPanelState } = vi.hoisted(() => ({
  chatPanelState: { mounts: 0 }
}))

vi.mock('@/components/chat/AgentChatPanel', async () => {
  const React = await import('react')
  return {
    AgentChatPanel: ({ sessionId }: { sessionId: string }) => {
      const [mountId] = React.useState(() => ++chatPanelState.mounts)
      return React.createElement('div', {
        'data-testid': 'chat-panel-stub',
        'data-mount': mountId,
        'data-session': sessionId
      })
    }
  }
})

const { logFrontendError } = vi.hoisted(() => ({
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError }))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: vi.fn((selector: (s: { activeProjectId: string }) => unknown) =>
    selector({ activeProjectId: 'proj-1' })
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector: (s: { terminals: never[] }) => unknown) =>
    selector({ terminals: [] })
  ),
  useTerminalActions: vi.fn(() => ({ setTerminalPtyId: vi.fn() }))
}))

// Mutable so the pane-ring tests can seed a multi-leaf tree, a fullscreen pane
// and the mobile shell. Defaults match the single-leaf desktop workspace the
// other suites in this file assume.
const { paneStateRef, mobileRef } = vi.hoisted(() => ({
  paneStateRef: {
    current: {
      activePaneId: 'pane-1',
      fullscreenPaneId: null as string | null,
      leafCount: 1
    }
  },
  mobileRef: { current: false as boolean }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      activePaneId: paneStateRef.current.activePaneId,
      fullscreenPaneId: paneStateRef.current.fullscreenPaneId,
      agentLauncherPaneId: null,
      setActivePane: vi.fn()
    })
  ),
  getAllLeafPanes: () =>
    Array.from({ length: paneStateRef.current.leafCount }, (_, index) => ({ id: `leaf-${index}` }))
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current
}))

// Mutable so the drop-abort test can flip isDragging mid-render.
const { paneDndStateRef } = vi.hoisted(() => ({
  paneDndStateRef: { isDragging: false }
}))

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({ isDragging: paneDndStateRef.isDragging, previewTarget: null })
}))

// Spec I/O matrix — "Edge drop / aborted" row: the shared framer-motion mock
// records the props the AnimatePresence gate receives so the test can prove
// the overlay unmounts THROUGH the presence boundary (exit fade) instead of
// a bare conditional.
vi.mock('framer-motion', async (importOriginal) => {
  const { installFramerMotionMock } = await import('@/test-utils/mock-framer-motion')
  return installFramerMotionMock(importOriginal)
})

vi.mock('@/components/workspace/WorkspaceTabBar', () => ({
  WorkspaceTabBar: () => <div data-testid="tabbar-stub" />
}))
vi.mock('@/components/workspace/DropZoneOverlay', () => ({
  DropZoneOverlay: () => <div data-testid="dropzone-overlay" />
}))
vi.mock('@/components/agents/AgentLauncher', () => ({
  AgentLauncher: () => <div data-testid="launcher-stub" />
}))
vi.mock('@/components/agents/AgentIcon', () => ({
  AgentIcon: () => <span data-testid="agent-icon-stub" />
}))

import { isValidElement, type ReactElement } from 'react'
import { framerMotionTestState, resetFramerMotionTestState } from '@/test-utils/mock-framer-motion'
import { DropZoneOverlay } from './DropZoneOverlay'
import { PaneContent } from './PaneContent'

const editorPane: LeafNode = {
  type: 'leaf',
  id: 'pane-1',
  activeTabId: 'tab-editor-1',
  tabs: [{ type: 'editor', id: 'tab-editor-1', filePath: '/project/foo.ts' }]
}

describe('PaneContent — editor pane lazy/Suspense boundary (CAP-6 Row 3)', () => {
  beforeEach(() => {
    editorMock.mockImplementation(({ filePath }: { filePath: string }) => (
      <div data-testid="editor-stub" data-filepath={filePath}>
        editor
      </div>
    ))
  })

  afterEach(() => {
    editorMock.mockReset()
    logFrontendError.mockReset()
  })

  it('renders EditorPanel through React.lazy + <Suspense>', async () => {
    render(<PaneContent pane={editorPane} />)

    const editor = await screen.findByTestId('editor-stub')
    expect(editor).toBeInTheDocument()
    expect(editor.getAttribute('data-filepath')).toBe('/project/foo.ts')
  })
})

describe('PaneContent — chunk-load failure error path (CAP-6 Patch 4)', () => {
  beforeEach(() => {
    editorMock.mockImplementation(() => {
      throw new Error('Failed to load dynamic target chunk')
    })
  })

  afterEach(() => {
    editorMock.mockReset()
    logFrontendError.mockReset()
  })

  it('surfaces the error via ErrorBoundary + logFrontendError when the editor chunk fails', async () => {
    render(
      <ErrorBoundary context="Editor Pane">
        <PaneContent pane={editorPane} />
      </ErrorBoundary>
    )

    // The ErrorBoundary catches the thrown error, calls logFrontendError,
    // and renders the ErrorFallback UI with the error message.
    await waitFor(() => {
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'ErrorBoundary:Editor Pane' })
      )
    })

    expect(screen.getByText('Something went wrong in Editor Pane')).toBeInTheDocument()
    expect(screen.getByText('Failed to load dynamic target chunk')).toBeInTheDocument()
  })
})

describe('PaneContent — drop-abort overlay exit', () => {
  beforeEach(() => {
    paneDndStateRef.isDragging = false
    resetFramerMotionTestState()
    editorMock.mockImplementation(({ filePath }: { filePath: string }) => (
      <div data-testid="editor-stub" data-filepath={filePath}>
        editor
      </div>
    ))
  })

  afterEach(() => {
    editorMock.mockReset()
    paneDndStateRef.isDragging = false
  })

  it('keeps the overlay inside AnimatePresence when isDragging flips off without a drop', () => {
    paneDndStateRef.isDragging = true

    const { rerender } = render(<PaneContent pane={editorPane} />)

    // While dragging, the presence boundary's child is the overlay element.
    // Each render pass logs all three pane boundaries in JSX order
    // (empty-pane launcher, drop-zone, overlay launcher) — the drop-zone
    // boundary is the middle entry of the latest pass.
    const mounted = framerMotionTestState.animatePresencePropsLog.at(-2)
    expect(mounted).toBeTruthy()
    expect(isValidElement(mounted?.children)).toBe(true)
    expect((mounted?.children as ReactElement).type).toBe(DropZoneOverlay)
    expect(screen.getByTestId('dropzone-overlay')).toBeInTheDocument()

    // Abort: isDragging flips false with no drop commit. The SAME
    // AnimatePresence stays mounted and now receives falsy children
    // (`false` or `null` — either means "no child") — so the overlay is
    // removed by the presence boundary (its exit fade can play) rather
    // than the boundary itself being torn down.
    framerMotionTestState.animatePresencePropsLog.length = 0
    paneDndStateRef.isDragging = false
    rerender(<PaneContent pane={editorPane} />)

    const latest = framerMotionTestState.animatePresencePropsLog.at(-2)
    expect(latest).toBeTruthy()
    // `false` or `null` — either means the gate holds no child.
    expect(latest?.children).toBeFalsy()
  })
})

describe('PaneContent — launcher→chat handoff', () => {
  const emptyPane: LeafNode = { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
  const terminalPane: LeafNode = {
    type: 'leaf',
    id: 'pane-1',
    activeTabId: 'tab-term-1',
    tabs: [{ type: 'terminal', id: 'tab-term-1', terminalId: 'term-1' }]
  }

  beforeEach(() => {
    resetFramerMotionTestState()
  })

  it('unmounts the empty-pane launcher through AnimatePresence when the first tab appears', () => {
    const { rerender } = render(<PaneContent pane={emptyPane} />)
    expect(screen.getByTestId('launcher-stub')).toBeInTheDocument()

    // The launcher gate's child is the keep-alive wrapper: a motion.div with
    // no enter animation and a delayed exit fade that covers the composer's
    // dive to the chat dock. First entry of each pass — see drop-abort test.
    const mounted = framerMotionTestState.animatePresencePropsLog.at(-3)
    expect(mounted).toBeTruthy()
    expect(isValidElement(mounted?.children)).toBe(true)
    const wrapper = mounted?.children as ReactElement<{
      exit?: unknown
      initial?: unknown
    }>
    expect(wrapper.props.exit).toEqual({ opacity: 0 })
    expect(wrapper.props.initial).toBe(false)

    // First tab appears (agent launch) — the boundary stays mounted and
    // receives falsy children, so the launcher exits THROUGH the presence
    // boundary instead of being cut away with it.
    framerMotionTestState.animatePresencePropsLog.length = 0
    rerender(<PaneContent pane={terminalPane} />)

    const latest = framerMotionTestState.animatePresencePropsLog.at(-3)
    expect(latest).toBeTruthy()
    expect(latest?.children).toBeFalsy()
  })
})

describe('PaneContent — agent-chat remap mount continuity', () => {
  const placeholderPane: LeafNode = {
    type: 'leaf',
    id: 'pane-1',
    activeTabId: 'chat-launch-1',
    tabs: [
      {
        type: 'agent-chat',
        id: 'chat-launch-1',
        sessionId: 'launch-1',
        mountKey: 'chat-launch-1'
      }
    ]
  }

  beforeEach(() => {
    chatPanelState.mounts = 0
    editorMock.mockImplementation(({ filePath }: { filePath: string }) => (
      <div data-testid="editor-stub" data-filepath={filePath}>
        editor
      </div>
    ))
  })

  afterEach(() => {
    editorMock.mockReset()
  })

  it('keeps AgentChatPanel mounted when the tab remaps to the real session id', async () => {
    const { rerender } = render(<PaneContent pane={placeholderPane} />)

    const stub = await screen.findByTestId('chat-panel-stub')
    expect(stub.getAttribute('data-session')).toBe('launch-1')
    const mountId = stub.getAttribute('data-mount')
    expect(chatPanelState.mounts).toBeGreaterThan(0)

    // remapAgentChatSession swaps tab.id/sessionId but preserves mountKey —
    // the wrapper key must stay stable so the same panel instance survives.
    const remappedPane: LeafNode = {
      ...placeholderPane,
      activeTabId: 'chat-s-real',
      tabs: [
        {
          type: 'agent-chat',
          id: 'chat-s-real',
          sessionId: 's-real',
          mountKey: 'chat-launch-1'
        }
      ]
    }
    rerender(<PaneContent pane={remappedPane} />)

    const stubAfter = await screen.findByTestId('chat-panel-stub')
    expect(stubAfter.getAttribute('data-session')).toBe('s-real')
    expect(stubAfter.getAttribute('data-mount')).toBe(mountId)
    expect(chatPanelState.mounts).toBe(Number(mountId))
  })

  it('remounts AgentChatPanel when the tab mountKey changes (new chat)', async () => {
    const { rerender } = render(<PaneContent pane={placeholderPane} />)

    const stub = await screen.findByTestId('chat-panel-stub')
    const mountId = stub.getAttribute('data-mount')

    const newChatPane: LeafNode = {
      ...placeholderPane,
      activeTabId: 'chat-s-other',
      tabs: [
        {
          type: 'agent-chat',
          id: 'chat-s-other',
          sessionId: 's-other',
          mountKey: 'chat-s-other'
        }
      ]
    }
    rerender(<PaneContent pane={newChatPane} />)

    const stubAfter = await screen.findByTestId('chat-panel-stub')
    expect(stubAfter.getAttribute('data-session')).toBe('s-other')
    expect(stubAfter.getAttribute('data-mount')).not.toBe(mountId)
  })

  it('a mountKey-less legacy tab still keys on tab.id (remounts on session swap)', async () => {
    const legacyPane: LeafNode = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-legacy',
      tabs: [{ type: 'agent-chat', id: 'chat-legacy', sessionId: 'legacy' }]
    }
    const { rerender } = render(<PaneContent pane={legacyPane} />)

    const stub = await screen.findByTestId('chat-panel-stub')
    const mountId = stub.getAttribute('data-mount')

    const swappedPane: LeafNode = {
      ...legacyPane,
      activeTabId: 'chat-s-real',
      tabs: [{ type: 'agent-chat', id: 'chat-s-real', sessionId: 's-real' }]
    }
    rerender(<PaneContent pane={swappedPane} />)

    const stubAfter = await screen.findByTestId('chat-panel-stub')
    expect(stubAfter.getAttribute('data-mount')).not.toBe(mountId)
  })

  // The mobile drawer (`findVisibleQuestionFocusTarget`) and the launcher read
  // this attribute to tell the chat on screen from the ones kept mounted behind it.
  it('marks only the active chat tab data-chat-tab-state="visible" and keeps the others mounted as "hidden"', async () => {
    const twoChats: LeafNode = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-a',
      tabs: [
        { type: 'agent-chat', id: 'chat-a', sessionId: 'a', mountKey: 'chat-a' },
        { type: 'agent-chat', id: 'chat-b', sessionId: 'b', mountKey: 'chat-b' }
      ]
    }
    const stateOf = (container: HTMLElement, session: string): string | null =>
      container
        .querySelector(`[data-testid="chat-panel-stub"][data-session="${session}"]`)
        ?.closest('[data-chat-tab-state]')
        ?.getAttribute('data-chat-tab-state') ?? null

    const { container, rerender } = render(<PaneContent pane={twoChats} />)
    await screen.findAllByTestId('chat-panel-stub')
    expect(stateOf(container, 'a')).toBe('visible')
    expect(stateOf(container, 'b')).toBe('hidden')

    rerender(<PaneContent pane={{ ...twoChats, activeTabId: 'chat-b' }} />)
    expect(stateOf(container, 'a')).toBe('hidden')
    expect(stateOf(container, 'b')).toBe('visible')
  })
})

describe('PaneContent — active-pane and fullscreen rings', () => {
  const pane: LeafNode = { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }

  const renderPane = (): HTMLElement => {
    const { container } = render(<PaneContent pane={pane} />)
    const root = container.querySelector('[data-pane-content="pane-1"]')
    if (!root) throw new Error('pane root not rendered')
    return root as HTMLElement
  }

  beforeEach(() => {
    resetFramerMotionTestState()
    mobileRef.current = false
    paneStateRef.current = { activePaneId: 'pane-1', fullscreenPaneId: null, leafCount: 1 }
  })

  afterEach(() => {
    mobileRef.current = false
    paneStateRef.current = { activePaneId: 'pane-1', fullscreenPaneId: null, leafCount: 1 }
  })

  it('desktop: the active pane of a multi-leaf tree keeps its ring', () => {
    paneStateRef.current = { activePaneId: 'pane-1', fullscreenPaneId: null, leafCount: 2 }

    const root = renderPane()

    expect(root.className).toContain('ring-1')
    expect(root.className).toContain('ring-primary/30')
    expect(root.className).not.toContain('rounded-xl')
  })

  it('desktop: a single-leaf workspace has no ring', () => {
    const root = renderPane()

    expect(root.className).not.toContain('ring-1')
  })

  it('desktop: a fullscreen pane keeps its ring and rounded clip', () => {
    paneStateRef.current = { activePaneId: 'pane-1', fullscreenPaneId: 'pane-1', leafCount: 2 }

    const root = renderPane()

    expect(root.className).toContain('ring-1')
    expect(root.className).toContain('ring-primary/30')
    expect(root.className).toContain('rounded-xl')
    expect(root.className).toContain('overflow-hidden')
  })

  it('mobile: the collapsed active leaf of a multi-leaf tree shows no ring', () => {
    mobileRef.current = true
    paneStateRef.current = { activePaneId: 'pane-1', fullscreenPaneId: null, leafCount: 2 }

    const root = renderPane()

    expect(root.className).not.toContain('ring-1')
    expect(root.className).not.toContain('ring-primary')
    // The leaf keeps the base chrome of a single-leaf workspace.
    expect(root.className).toContain('flex-col')
    expect(root.className).toContain('h-full')
  })

  it('mobile: a fullscreen pane shows no fullscreen ring or clip', () => {
    mobileRef.current = true
    paneStateRef.current = { activePaneId: 'pane-1', fullscreenPaneId: 'pane-1', leafCount: 2 }

    const root = renderPane()

    expect(root.className).not.toContain('ring-1')
    expect(root.className).not.toContain('ring-primary')
    expect(root.className).not.toContain('rounded-xl')
  })
})
