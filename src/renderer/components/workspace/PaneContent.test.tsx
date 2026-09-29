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

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      activePaneId: 'pane-1',
      fullscreenPaneId: null,
      agentLauncherPaneId: null,
      setActivePane: vi.fn()
    })
  ),
  getAllLeafPanes: () => []
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => false
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
