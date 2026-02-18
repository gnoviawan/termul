import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import type { WorkspaceTab } from '@/stores/workspace-store'

const mockSetActiveTab = vi.fn()
const mockSetActivePane = vi.fn()
const mockReorderTabsInPane = vi.fn()
const mockCloseTab = vi.fn()

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      setActiveTab: mockSetActiveTab,
      setActivePane: mockSetActivePane,
      reorderTabsInPane: mockReorderTabsInPane,
      closeTab: mockCloseTab
    })
  ),
  editorTabId: (filePath: string) => `edit-${filePath}`
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: vi.fn((selector: (state: { openFiles: Map<string, { isDirty: boolean }> }) => unknown) =>
    selector({
      openFiles: new Map<string, { isDirty: boolean }>()
    })
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector: (state: { terminals: Array<{ id: string; name: string; shell: string }> }) => unknown) =>
    selector({
      terminals: [{ id: 'term-1', name: 'Terminal 1', shell: 'bash' }]
    })
  )
}))

const mockStartTabDrag = vi.hoisted(() => vi.fn())
const mockUsePaneDnd = vi.hoisted(() =>
  vi.fn(() => ({
    startTabDrag: mockStartTabDrag,
    dragPayload: null
  }))
)

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: mockUsePaneDnd
}))

vi.mock('framer-motion', () => ({
  Reorder: {
    Group: ({ children, onReorder }: { children: React.ReactNode; onReorder: (tabs: WorkspaceTab[]) => void }) => (
      <div data-testid="reorder-group" data-has-onreorder={Boolean(onReorder)}>
        {children}
      </div>
    ),
    Item: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  }
}))

beforeEach(() => {
  mockSetActiveTab.mockReset()
  mockSetActivePane.mockReset()
  mockReorderTabsInPane.mockReset()
  mockCloseTab.mockReset()
  mockStartTabDrag.mockReset()
  mockUsePaneDnd.mockReset()
  mockUsePaneDnd.mockReturnValue({
    startTabDrag: mockStartTabDrag,
    dragPayload: null
  })

  vi.stubGlobal('api', {
    shell: {
      getAvailableShells: vi.fn().mockResolvedValue({
        success: true,
        data: {
          default: { name: 'bash', displayName: 'Bash', path: '/bin/bash' },
          available: [{ name: 'bash', displayName: 'Bash', path: '/bin/bash' }]
        }
      })
    },
    clipboard: {
      writeText: vi.fn()
    }
  })
})

async function flushShellEffect(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('WorkspaceTabBar', () => {
  it('shows pane plus action and no pane-close side control', async () => {
    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={[]}
        activeTabId={null}
        onNewTerminal={vi.fn()}
      />
    )

    await flushShellEffect()

    expect(screen.getByTitle('New terminal (default shell)')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.queryByTitle('Close pane')).not.toBeInTheDocument()
    })
  })

  it('calls pane-scoped onNewTerminal when plus is clicked', async () => {
    const onNewTerminal = vi.fn()

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={[]}
        activeTabId={null}
        onNewTerminal={onNewTerminal}
      />
    )

    await flushShellEffect()

    fireEvent.click(screen.getByTitle('New terminal (default shell)'))

    expect(onNewTerminal).toHaveBeenCalledTimes(1)
  })

  it('renders editor tab with non-jitter active style class', async () => {
    const tabs: WorkspaceTab[] = [{ type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }]

    const { container } = render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="edit-/a.ts"
      />
    )

    await flushShellEffect()

    const tabEl = container.querySelector('.border-b-primary') as HTMLElement
    expect(tabEl).toBeTruthy()
    expect(tabEl.className).toContain('border-b-2')
    expect(tabEl.className).toContain('border-b-primary')
    expect(tabEl.className).not.toContain('border-t-2')
  })

  it('uses onCloseEditorTab callback when closing editor tab', async () => {
    const onCloseEditorTab = vi.fn()
    const tabs: WorkspaceTab[] = [{ type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }]

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="edit-/a.ts"
        onCloseEditorTab={onCloseEditorTab}
      />
    )

    await flushShellEffect()

    const closeButtons = screen.getAllByRole('button')
    const tabCloseButton = closeButtons.find((button) =>
      button.className.includes('opacity-0 group-hover:opacity-100')
    )

    expect(tabCloseButton).toBeTruthy()
    fireEvent.click(tabCloseButton!)

    expect(onCloseEditorTab).toHaveBeenCalledWith('/a.ts')
    expect(mockCloseTab).not.toHaveBeenCalled()
  })
})
