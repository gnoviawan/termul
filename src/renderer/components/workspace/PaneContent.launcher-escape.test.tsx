import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeafNode } from '@/types/workspace.types'

// L-32: the AgentLauncher overlay wrapper hid the launcher on ANY Escape that
// bubbled through the React tree, portals included, so Esc inside a selector
// (a Radix dialog or popover portaled out of the wrapper) closed the selector
// AND the launcher. The wrapper now acts only on an Esc that is not prevented
// (Radix prevents the Esc it consumes) and that came from inside the wrapper.

const { storeState, launcherFlags } = vi.hoisted(() => ({
  // Whether the launcher stub also renders the Radix selector dialog.
  launcherFlags: { selectorOpen: false },
  storeState: {
    root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
    activePaneId: 'pane-1',
    fullscreenPaneId: null as string | null,
    agentLauncherPaneId: 'pane-1' as string | null,
    setActivePane: vi.fn(),
    hideAgentLauncher: vi.fn()
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (s: typeof storeState) => unknown) => selector(storeState)),
    { getState: () => storeState }
  ),
  getAllLeafPanes: () => [{ id: 'pane-1' }]
}))

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

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => false }))
vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({ isDragging: false, previewTarget: null })
}))
vi.mock('@/components/workspace/WorkspaceTabBar', () => ({
  WorkspaceTabBar: () => <div data-testid="tabbar-stub" />
}))
vi.mock('@/components/workspace/DropZoneOverlay', () => ({
  DropZoneOverlay: () => null
}))
vi.mock('@/components/agents/AgentIcon', () => ({
  AgentIcon: () => <span data-testid="agent-icon-stub" />
}))

// The launcher stub: a button inside the wrapper, a plain React portal out of
// it, and a REAL Radix dialog (the SelectorModal shell) portaled out of it.
vi.mock('@/components/agents/AgentLauncher', async () => {
  const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
    '@/components/ui/dialog'
  )
  return {
    AgentLauncher: () => (
      <div data-testid="launcher-root">
        <button type="button" data-testid="launcher-button">
          inside the launcher
        </button>
        {createPortal(
          <button type="button" data-testid="portal-button">
            inside a plain portal
          </button>,
          document.body
        )}
        {launcherFlags.selectorOpen ? (
          <Dialog defaultOpen>
            <DialogContent>
              <DialogTitle>Select agent</DialogTitle>
              <DialogDescription>Pick one</DialogDescription>
              <button type="button" data-testid="selector-button">
                inside the selector
              </button>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
    )
  }
})

import { PaneContent } from './PaneContent'

const pane: LeafNode = {
  type: 'leaf',
  id: 'pane-1',
  activeTabId: 'git-1',
  tabs: [{ type: 'git', id: 'git-1', cwd: '/repo' }]
}

describe('PaneContent AgentLauncher overlay: Esc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.agentLauncherPaneId = 'pane-1'
    launcherFlags.selectorOpen = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hides the launcher once on a plain Esc inside the launcher', async () => {
    render(<PaneContent pane={pane} />)
    const button = await screen.findByTestId('launcher-button')

    fireEvent.keyDown(button, { key: 'Escape' })

    expect(storeState.hideAgentLauncher).toHaveBeenCalledTimes(1)
  })

  it('ignores an Esc from a plain React portal child (outside the wrapper)', async () => {
    render(<PaneContent pane={pane} />)
    const portalButton = await screen.findByTestId('portal-button')

    fireEvent.keyDown(portalButton, { key: 'Escape' })

    expect(storeState.hideAgentLauncher).not.toHaveBeenCalled()
  })

  it('ignores an Esc that something already prevented, even from inside the launcher', async () => {
    render(<PaneContent pane={pane} />)
    const button = await screen.findByTestId('launcher-button')
    const owner = (event: KeyboardEvent): void => event.preventDefault()
    document.addEventListener('keydown', owner, true)

    fireEvent.keyDown(button, { key: 'Escape' })
    document.removeEventListener('keydown', owner, true)

    expect(storeState.hideAgentLauncher).not.toHaveBeenCalled()
  })

  it('ignores other keys', async () => {
    render(<PaneContent pane={pane} />)
    const button = await screen.findByTestId('launcher-button')

    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: 'a' })

    expect(storeState.hideAgentLauncher).not.toHaveBeenCalled()
  })

  it('Esc inside a real Radix selector dialog closes only the selector and keeps the launcher', async () => {
    launcherFlags.selectorOpen = true
    render(<PaneContent pane={pane} />)
    const selectorButton = await screen.findByTestId('selector-button')

    fireEvent.keyDown(selectorButton, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('selector-button')).not.toBeInTheDocument())
    expect(storeState.hideAgentLauncher).not.toHaveBeenCalled()
    expect(screen.getByTestId('launcher-root')).toBeInTheDocument()

    // With the selector gone, the next Esc inside the launcher hides it.
    fireEvent.keyDown(screen.getByTestId('launcher-button'), { key: 'Escape' })
    expect(storeState.hideAgentLauncher).toHaveBeenCalledTimes(1)
  })
})
