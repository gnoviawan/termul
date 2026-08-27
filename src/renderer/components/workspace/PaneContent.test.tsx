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

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({ isDragging: false, previewTarget: null })
}))

vi.mock('@/components/workspace/WorkspaceTabBar', () => ({
  WorkspaceTabBar: () => <div data-testid="tabbar-stub" />
}))
vi.mock('@/components/workspace/DropZoneOverlay', () => ({
  DropZoneOverlay: () => null
}))
vi.mock('@/components/agents/AgentLauncher', () => ({
  AgentLauncher: () => <div data-testid="launcher-stub" />
}))
vi.mock('@/components/agents/AgentIcon', () => ({
  AgentIcon: () => <span data-testid="agent-icon-stub" />
}))

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
