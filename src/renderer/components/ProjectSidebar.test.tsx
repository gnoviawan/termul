import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { ProjectSidebar } from './ProjectSidebar'

const {
  mockGetAvailableShells,
  mockSpawnTerminalInPane,
  mockActivateAndOpenTerminal,
  mockOpenTerminalAtCwd,
  mockAddAgentChatTab,
  mockOpenHistorySession,
  mockDeleteHistorySession,
  mockUseProjectsWithActivity,
  mockUseProjectsWithErrors,
  mockUseProjectsWithActiveAgentChat
} = vi.hoisted(() => ({
  mockGetAvailableShells: vi.fn(),
  mockSpawnTerminalInPane: vi.fn(),
  mockActivateAndOpenTerminal: vi.fn(),
  mockOpenTerminalAtCwd: vi.fn(),
  mockAddAgentChatTab: vi.fn(),
  mockOpenHistorySession: vi.fn(),
  mockDeleteHistorySession: vi.fn(),
  mockUseProjectsWithActivity: vi.fn(),
  mockUseProjectsWithErrors: vi.fn(),
  mockUseProjectsWithActiveAgentChat: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  shellApi: {
    getAvailableShells: mockGetAvailableShells
  },
  worktreeApi: {
    list: vi.fn().mockResolvedValue({ success: true, data: [] }),
    checkDirty: vi.fn().mockResolvedValue({
      success: true,
      data: { modified: 0, staged: 0, untracked: 0, hasChanges: false }
    }),
    ensureSymlinks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    remove: vi.fn().mockResolvedValue({ success: true })
  },
  clipboardApi: {
    writeText: vi.fn().mockResolvedValue({ success: true })
  }
}))

vi.mock('@/stores/terminal-store', async () => {
  const actual = await vi.importActual('@/stores/terminal-store')
  return {
    ...actual,
    useProjectsWithActivity: () => mockUseProjectsWithActivity(),
    useProjectsWithErrors: () => mockUseProjectsWithErrors()
  }
})

vi.mock('@/stores/acp-store', async () => {
  const actual = await vi.importActual('@/stores/acp-store')
  return {
    ...actual,
    useProjectsWithActiveAgentChat: () => mockUseProjectsWithActiveAgentChat()
  }
})

vi.mock('@/lib/terminal-spawn', () => ({
  spawnTerminalInPane: mockSpawnTerminalInPane,
  activateAndOpenTerminal: mockActivateAndOpenTerminal,
  openTerminalAtCwd: mockOpenTerminalAtCwd
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual('@/lib/utils')
  return { ...actual }
})

// Stub the Radix context-menu primitives. The real primitives render via a
// portal + Radix positioning + pointer-based `onSelect` that is hard to drive
// from jsdom; this stub models the open/submenu/radio state in plain DOM so
// the existing menu tests (open on right-click, click wiring, submenu hover,
// Escape close, capability-gated items) assert the gating logic without the
// Radix portal/pointer plumbing. Mirrors the FileTreeContextMenu /
// GlobalContextMenu stub patterns.
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const MenuCtx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {}
  })
  const SubCtx = React.createContext<{ subOpen: boolean; setSubOpen: (o: boolean) => void }>({
    subOpen: false,
    setSubOpen: () => {}
  })
  const RadioCtx = React.createContext<{ value: string; onValueChange: (v: string) => void }>({
    value: '',
    onValueChange: () => {}
  })

  const ContextMenu = ({ children }: { children: React.ReactNode }) => {
    const [open, setOpen] = React.useState(false)
    React.useEffect(() => {
      if (!open) return
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false)
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [open])
    return <MenuCtx.Provider value={{ open, setOpen }}>{children}</MenuCtx.Provider>
  }
  const ContextMenuTrigger = ({
    children,
    asChild
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => {
    const { setOpen } = React.useContext(MenuCtx)
    const merged = (e: React.MouseEvent) => {
      // F2: mirror Radix's composeEventHandlers({ checkForDefaultPrevented: true }) —
      // the child's onContextMenu runs first; if it called preventDefault, do NOT
      // open. This makes the stub catch F1-type regressions (a handler that
      // re-introduces preventDefault would suppress the menu open).
      if (e.defaultPrevented) return
      e.preventDefault()
      setOpen(true)
    }
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        onContextMenu?: (e: React.MouseEvent) => void
      }>
      return React.cloneElement(child, {
        onContextMenu: (e: React.MouseEvent) => {
          child.props.onContextMenu?.(e)
          merged(e)
        }
      })
    }
    return <div onContextMenu={merged}>{children}</div>
  }
  const ContextMenuContent = ({ children }: { children: React.ReactNode }) => {
    const { open } = React.useContext(MenuCtx)
    if (!open) return null
    return <div role="menu">{children}</div>
  }
  const ContextMenuItem = ({
    children,
    disabled,
    onSelect,
    variant
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
    variant?: 'default' | 'destructive'
  }) => (
    <div
      role="menuitem"
      data-disabled={disabled ? '' : undefined}
      data-variant={variant}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
    >
      {children}
    </div>
  )
  const ContextMenuSeparator = () => <hr />
  const ContextMenuSub = ({ children }: { children: React.ReactNode }) => {
    const [subOpen, setSubOpen] = React.useState(false)
    return <SubCtx.Provider value={{ subOpen, setSubOpen }}>{children}</SubCtx.Provider>
  }
  const ContextMenuSubTrigger = ({ children }: { children: React.ReactNode }) => {
    const { setSubOpen } = React.useContext(SubCtx)
    return (
      <div role="menuitem" onMouseEnter={() => setSubOpen(true)}>
        {children}
      </div>
    )
  }
  const ContextMenuSubContent = ({ children }: { children: React.ReactNode }) => {
    const { subOpen } = React.useContext(SubCtx)
    if (!subOpen) return null
    return <div>{children}</div>
  }
  const ContextMenuRadioGroup = ({
    children,
    value,
    onValueChange
  }: {
    children: React.ReactNode
    value: string
    onValueChange: (v: string) => void
  }) => <RadioCtx.Provider value={{ value, onValueChange }}>{children}</RadioCtx.Provider>
  const ContextMenuRadioItem = ({
    children,
    value
  }: {
    children: React.ReactNode
    value: string
  }) => {
    const { onValueChange } = React.useContext(RadioCtx)
    return (
      <div role="menuitemradio" onClick={() => onValueChange(value)}>
        {children}
      </div>
    )
  }
  const ContextMenuCheckboxItem = ({
    children,
    checked,
    onSelect
  }: {
    children: React.ReactNode
    checked?: boolean
    onSelect?: () => void
  }) => (
    <div
      role="menuitemcheckbox"
      data-checked={checked ? '' : undefined}
      onClick={() => onSelect?.()}
    >
      {children}
    </div>
  )
  return {
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubTrigger,
    ContextMenuSubContent,
    ContextMenuRadioGroup,
    ContextMenuRadioItem,
    ContextMenuCheckboxItem
  }
})

// Setup mock data
beforeEach(() => {
  mockGetAvailableShells.mockReset()
  mockSpawnTerminalInPane.mockReset()
  mockSpawnTerminalInPane.mockResolvedValue({ success: true, data: { id: 'term-1' } })
  mockActivateAndOpenTerminal.mockReset()
  mockActivateAndOpenTerminal.mockResolvedValue({ status: 'opened', terminalId: 'term-1' })
  mockOpenTerminalAtCwd.mockReset()
  mockOpenTerminalAtCwd.mockResolvedValue({ status: 'opened', terminalId: 'term-1' })
  mockAddAgentChatTab.mockReset()
  mockOpenHistorySession.mockReset()
  mockOpenHistorySession.mockResolvedValue(undefined)
  mockDeleteHistorySession.mockReset()
  mockDeleteHistorySession.mockResolvedValue(undefined)
  mockGetAvailableShells.mockResolvedValue({
    success: true,
    data: {
      default: { path: '/bin/bash', name: 'bash', displayName: 'Bash' },
      available: [
        { path: '/bin/bash', name: 'bash', displayName: 'Bash' },
        { path: '/usr/bin/zsh', name: 'zsh', displayName: 'Zsh' },
        { path: '/bin/sh', name: 'sh', displayName: 'Shell' }
      ]
    }
  })
  mockUseProjectsWithActivity.mockReset()
  mockUseProjectsWithActivity.mockReturnValue([])
  mockUseProjectsWithActiveAgentChat.mockReset()
  mockUseProjectsWithActiveAgentChat.mockReturnValue([])
  mockUseProjectsWithErrors.mockReset()
  mockUseProjectsWithErrors.mockReturnValue(new Set())
  // Reset chat-history store state to a clean baseline. ProjectChatList reads
  // `sessionIndex` + the open/delete actions; drive them through spies so the
  // integration tests stay deterministic without exercising the real reopen.
  useAcpStore.setState({
    sessionIndex: [],
    openHistorySession: mockOpenHistorySession,
    deleteHistorySession: mockDeleteHistorySession
  })
  useWorkspaceStore.setState({
    activePaneId: 'pane-1',
    addAgentChatTab: mockAddAgentChatTab
  })
})

const mockProjects: Project[] = [
  { id: '1', name: 'Project One', color: 'blue', gitBranch: 'main' },
  { id: '2', name: 'Project Two', color: 'green', gitBranch: 'develop' }
]

const defaultProps = {
  projects: mockProjects,
  activeProjectId: '1',
  onSelectProject: vi.fn(),
  onNewProject: vi.fn(),
  onUpdateProject: vi.fn(),
  onDeleteProject: vi.fn(),
  onArchiveProject: vi.fn(),
  onRestoreProject: vi.fn(),
  onReorderProjects: vi.fn()
}

const renderWithRouter = (props = {}) => {
  return render(
    <MemoryRouter>
      <ProjectSidebar {...defaultProps} {...props} />
    </MemoryRouter>
  )
}

// The project chat list is collapsed by default and only expands via the
// chevron, so tests that assert on chat rows must open the section first.
// `getAllByLabelText` because every project now shows a chevron; [0] is the
// first project in render order.
const expandChats = () => {
  const chevrons = screen.getAllByLabelText('Expand chats')
  fireEvent.click(chevrons[0])
}

describe('ProjectSidebar Context Menu', () => {
  it('should open context menu on right-click', () => {
    renderWithRouter()

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)

    expect(screen.getByText('Rename')).toBeInTheDocument()
    expect(screen.getByText('Change Color')).toBeInTheDocument()
    expect(screen.getByText('Archive')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('should close context menu on escape', async () => {
    renderWithRouter()

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)

    expect(screen.getByText('Rename')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByText('Rename')).not.toBeInTheDocument()
    })
  })

  it('should start inline editing when Rename is clicked', async () => {
    renderWithRouter()

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)

    fireEvent.click(screen.getByText('Rename'))

    await waitFor(() => {
      const input = screen.getByRole('textbox')
      expect(input).toBeInTheDocument()
      expect(input).toHaveValue('Project One')
    })
  })

  it('should save rename on Enter key', async () => {
    const onUpdateProject = vi.fn()
    renderWithRouter({ onUpdateProject })

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)
    fireEvent.click(screen.getByText('Rename'))

    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'New Project Name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onUpdateProject).toHaveBeenCalledWith('1', { name: 'New Project Name' })
  })

  it('should cancel rename on Escape key', async () => {
    const onUpdateProject = vi.fn()
    renderWithRouter({ onUpdateProject })

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)
    fireEvent.click(screen.getByText('Rename'))

    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'New Name' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })
    expect(onUpdateProject).not.toHaveBeenCalled()
  })

  it('should call onArchiveProject when Archive is clicked', () => {
    const onArchiveProject = vi.fn()
    renderWithRouter({ onArchiveProject })

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)
    fireEvent.click(screen.getByText('Archive'))

    expect(onArchiveProject).toHaveBeenCalledWith('1')
  })

  it('should show delete confirmation dialog when Delete is clicked', async () => {
    renderWithRouter()

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)
    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => {
      expect(screen.getByText('Delete Project')).toBeInTheDocument()
      expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument()
    })
  })

  it('should call onDeleteProject when delete is confirmed', async () => {
    const onDeleteProject = vi.fn()
    renderWithRouter({ onDeleteProject })

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)
    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => {
      expect(screen.getByText('Delete Project')).toBeInTheDocument()
    })

    // Click the Delete button in the confirmation dialog
    const confirmButtons = screen.getAllByText('Delete')
    const confirmButton = confirmButtons[confirmButtons.length - 1]
    fireEvent.click(confirmButton)

    expect(onDeleteProject).toHaveBeenCalledWith('1')
  })

  it('should close delete dialog when cancelled', async () => {
    const onDeleteProject = vi.fn()
    renderWithRouter({ onDeleteProject })

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)
    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => {
      expect(screen.getByText('Delete Project')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Cancel'))

    await waitFor(() => {
      expect(screen.queryByText('Delete Project')).not.toBeInTheDocument()
    })
    expect(onDeleteProject).not.toHaveBeenCalled()
  })

  it('should open color picker when Change Color is clicked', async () => {
    renderWithRouter()

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)
    fireEvent.click(screen.getByText('Change Color'))

    await waitFor(() => {
      expect(screen.getByText('Select Color')).toBeInTheDocument()
    })
  })
})

// F1/F2 regression guards: assert the menu OPENS on right-click for each
// surface. The F2 stub (checkForDefaultPrevented) skips open if the child
// handler calls preventDefault — so if F1's preventDefault removal is ever
// reverted in handleContextMenu / handleGroupContextMenu, these tests fail
// (the menu items vanish because Radix's open step is skipped).
describe('ProjectSidebar context menu open regression (F1/F2)', () => {
  beforeEach(() => {
    useProjectStore.setState({ groups: [] })
  })

  it('project row menu opens on right-click', () => {
    renderWithRouter()

    fireEvent.contextMenu(screen.getByText('Project One'))

    expect(screen.getByText('Rename')).toBeInTheDocument()
    expect(screen.getByText('Archive')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('group header menu opens on right-click', () => {
    useProjectStore.setState({
      groups: [{ id: 'group-1', name: 'My Folder', projectIds: ['1'], isCollapsed: false }]
    })
    renderWithRouter()

    fireEvent.contextMenu(screen.getByText('My Folder'))

    expect(screen.getByText('Rename Group')).toBeInTheDocument()
    expect(screen.getByText('Change Color')).toBeInTheDocument()
    expect(screen.getByText('Delete Group (Keep Projects)')).toBeInTheDocument()
  })

  it('archived project menu opens on right-click', async () => {
    const archived: Project[] = [
      { id: '1', name: 'Active Project', color: 'blue', gitBranch: 'main' },
      {
        id: '2',
        name: 'Archived Project',
        color: 'green',
        gitBranch: 'develop',
        isArchived: true
      }
    ]
    renderWithRouter({ projects: archived })

    fireEvent.click(screen.getByText(/Archived \(1\)/))
    await waitFor(() => expect(screen.getByText('Archived Project')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('Archived Project'))

    expect(screen.getByText('Restore')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })
})

describe('ProjectSidebar', () => {
  it('should render project list', () => {
    renderWithRouter()

    expect(screen.getByText('Project One')).toBeInTheDocument()
    expect(screen.getByText('Project Two')).toBeInTheDocument()
  })

  it('should call onSelectProject when project is clicked', () => {
    const onSelectProject = vi.fn()
    renderWithRouter({ onSelectProject })

    fireEvent.click(screen.getByText('Project Two'))

    expect(onSelectProject).toHaveBeenCalledWith('2')
  })

  it('should call onNewProject when header + button is clicked', () => {
    const onNewProject = vi.fn()
    renderWithRouter({ onNewProject })

    // Use data-testid for robust button selection
    const headerButton = screen.getByTestId('header-new-project')
    fireEvent.click(headerButton)

    expect(onNewProject).toHaveBeenCalled()
  })

  it('should show version label at the bottom', () => {
    renderWithRouter({})

    expect(screen.getByText(/Termul v/)).toBeInTheDocument()
  })

  it('should show empty state when no projects', () => {
    renderWithRouter({ projects: [] })

    expect(screen.getByText('No projects yet')).toBeInTheDocument()
  })

  it('should not render removed navigation items', () => {
    renderWithRouter()

    // These items were removed from the sidebar
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument()
    expect(screen.queryByText('Snapshots')).not.toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    expect(screen.queryByText('Preferences')).not.toBeInTheDocument()
  })

  it('should not render removed action items', () => {
    renderWithRouter()

    // These actions were removed from the sidebar
    expect(screen.queryByText('Scan Directories')).not.toBeInTheDocument()
    expect(screen.queryByText('Import Config')).not.toBeInTheDocument()
  })

  it('should handle project with empty name gracefully', () => {
    const projectsWithEmptyName: Project[] = [
      { id: '1', name: '', color: 'blue', gitBranch: 'main' }
    ]
    renderWithRouter({ projects: projectsWithEmptyName })

    // Empty-named project still renders its row without crashing.
    expect(screen.getByTestId('active-projects-container')).toBeInTheDocument()
  })
})

describe('ProjectSidebar Name Truncation', () => {
  const longName =
    'A Very Long Project Name That Would Otherwise Wrap Onto A Second Line In The Narrow Sidebar'

  it('truncates a long active project name instead of wrapping', () => {
    renderWithRouter({
      projects: [{ id: '1', name: longName, color: 'blue', gitBranch: 'main' }],
      activeProjectId: '1'
    })

    const nameEl = screen.getByText(longName)
    // truncate => overflow-hidden + text-ellipsis + whitespace-nowrap;
    // min-w-0 lets the flex child shrink below its content width so clipping kicks in.
    expect(nameEl).toHaveClass('truncate', 'min-w-0', 'flex-1')
    // Full name remains discoverable on hover.
    expect(nameEl).toHaveAttribute('title', longName)
  })

  it('truncates a long archived project name and exposes the full name via title', () => {
    renderWithRouter({
      projects: [
        { id: '1', name: 'Active Project', color: 'blue', gitBranch: 'main' },
        { id: '2', name: longName, color: 'green', gitBranch: 'develop', isArchived: true }
      ]
    })

    // Expand the archived section.
    fireEvent.click(screen.getByText(/Archived \(1\)/))

    const nameEl = screen.getByText(longName)
    expect(nameEl).toHaveClass('truncate', 'min-w-0', 'flex-1')
    expect(nameEl).toHaveAttribute('title', longName)
  })
})

describe('ProjectSidebar Archived Projects', () => {
  const projectsWithArchived: Project[] = [
    { id: '1', name: 'Active Project', color: 'blue', gitBranch: 'main' },
    { id: '2', name: 'Archived Project', color: 'green', gitBranch: 'develop', isArchived: true }
  ]

  it('should show archived section toggle when there are archived projects', () => {
    renderWithRouter({ projects: projectsWithArchived })

    expect(screen.getByText(/Archived \(1\)/)).toBeInTheDocument()
  })

  it('should not show archived projects by default', () => {
    renderWithRouter({ projects: projectsWithArchived })

    expect(screen.getByText('Active Project')).toBeInTheDocument()
    expect(screen.queryByText('Archived Project')).not.toBeInTheDocument()
  })

  it('should show archived projects when toggle is clicked', async () => {
    renderWithRouter({ projects: projectsWithArchived })

    fireEvent.click(screen.getByText(/Archived \(1\)/))

    await waitFor(() => {
      expect(screen.getByText('Archived Project')).toBeInTheDocument()
    })
  })

  it('should show Restore option in context menu for archived projects', async () => {
    renderWithRouter({ projects: projectsWithArchived })

    // Expand archived section
    fireEvent.click(screen.getByText(/Archived \(1\)/))

    await waitFor(() => {
      expect(screen.getByText('Archived Project')).toBeInTheDocument()
    })

    // Right-click on archived project
    fireEvent.contextMenu(screen.getByText('Archived Project'))

    expect(screen.getByText('Restore')).toBeInTheDocument()
    expect(screen.queryByText('Rename')).not.toBeInTheDocument()
    expect(screen.queryByText('Archive')).not.toBeInTheDocument()
  })

  it('should call onRestoreProject when Restore is clicked', async () => {
    const onRestoreProject = vi.fn()
    renderWithRouter({ projects: projectsWithArchived, onRestoreProject })

    // Expand archived section
    fireEvent.click(screen.getByText(/Archived \(1\)/))

    await waitFor(() => {
      expect(screen.getByText('Archived Project')).toBeInTheDocument()
    })

    // Right-click on archived project and click Restore
    fireEvent.contextMenu(screen.getByText('Archived Project'))
    fireEvent.click(screen.getByText('Restore'))

    expect(onRestoreProject).toHaveBeenCalledWith('2')
  })

  it('should not show archived section when there are no archived projects', () => {
    renderWithRouter({ projects: mockProjects })

    expect(screen.queryByText(/Archived/)).not.toBeInTheDocument()
  })

  it('does not apply extra opacity to an archived project activity spinner', () => {
    mockUseProjectsWithActivity.mockReturnValue(['2'])
    renderWithRouter({ projects: projectsWithArchived })
    fireEvent.click(screen.getByText(/Archived \(1\)/))

    const row = screen.getByTestId('archived-project-item-2')
    const spinner = screen.getByRole('status', { name: 'Project activity' })
    expect(row).toHaveClass('opacity-60')
    expect(spinner).not.toHaveClass('opacity-60')
  })
})

describe('ProjectSidebar Default Shell Submenu', () => {
  it('should show Set Default Shell menu item with submenu', async () => {
    renderWithRouter()

    // Wait for shells to be fetched
    await waitFor(() => {
      expect(mockGetAvailableShells).toHaveBeenCalled()
    })

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)

    await waitFor(() => {
      expect(screen.getByText('Default Shell')).toBeInTheDocument()
    })
  })

  it('should call onUpdateProject when shell is selected from submenu', async () => {
    const onUpdateProject = vi.fn()
    renderWithRouter({ onUpdateProject })

    // Wait for shells to be fetched
    await waitFor(() => {
      expect(mockGetAvailableShells).toHaveBeenCalled()
    })

    const projectItem = screen.getByText('Project One')
    fireEvent.contextMenu(projectItem)

    // Hover over Default Shell to show submenu
    const shellMenuItem = await screen.findByText('Default Shell')
    fireEvent.mouseEnter(shellMenuItem.closest('div')!)

    // Click on Zsh in submenu
    await waitFor(() => {
      expect(screen.getByText('Zsh')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Zsh'))

    expect(onUpdateProject).toHaveBeenCalledWith('1', { defaultShell: '/usr/bin/zsh' })
  })
})

describe('ProjectSidebar Activity Indicator', () => {
  function activityIndicator(item: HTMLElement): HTMLElement | null {
    return item.querySelector('[title="Activity"]')
  }

  beforeEach(() => {
    mockUseProjectsWithActiveAgentChat.mockReturnValue([])
  })

  it('should not show activity indicator when hasActivity is false', () => {
    mockUseProjectsWithActivity.mockReturnValue([])
    renderWithRouter()

    const item = screen.getByTestId('project-item-1')
    expect(activityIndicator(item)).toBeNull()
  })

  it('should show activity indicator when terminal activity is true', () => {
    mockUseProjectsWithActivity.mockReturnValue(['2'])
    renderWithRouter()

    const item = screen.getByTestId('project-item-2')
    expect(activityIndicator(item)).not.toBeNull()
    expect(activityIndicator(item)).toHaveAttribute('title', 'Activity')
    expect(screen.getByRole('status', { name: 'Project activity' })).toBeInTheDocument()
  })

  it('should show activity indicator when agent chat is active', () => {
    mockUseProjectsWithActivity.mockReturnValue([])
    mockUseProjectsWithActiveAgentChat.mockReturnValue(['2'])
    renderWithRouter()

    const item = screen.getByTestId('project-item-2')
    expect(activityIndicator(item)).not.toBeNull()
    expect(screen.getByRole('status', { name: 'Project activity' })).toBeInTheDocument()
  })

  it('should show activity indicator even when project is active if hasActivity is true', () => {
    mockUseProjectsWithActivity.mockReturnValue(['1'])
    renderWithRouter()

    const item = screen.getByTestId('project-item-1')
    expect(activityIndicator(item)).not.toBeNull()
  })
})

describe('ProjectSidebar Project Chat List', () => {
  const chatEntry = (overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry => ({
    id: 'chat-1',
    agentId: 'agent-1',
    title: 'Refactor sidebar',
    cwd: '/repo/main',
    projectId: '1',
    createdAt: 1000,
    lastActivityAt: 2000,
    messageCount: 5,
    status: 'active',
    ...overrides
  })

  const projectWithChats: Project[] = [
    { id: '1', name: 'Project One', color: 'blue', gitBranch: 'main' }
  ]

  it('renders the per-project chat search and chat rows when expanded', () => {
    useAcpStore.setState({ sessionIndex: [chatEntry()] })
    renderWithRouter({ projects: projectWithChats, activeProjectId: '1' })
    expandChats()

    expect(screen.getByLabelText('Search chats')).toBeInTheDocument()
    expect(screen.getByText('Refactor sidebar')).toBeInTheDocument()
  })

  it('shows the empty state when the project has no chats', () => {
    renderWithRouter({ projects: projectWithChats, activeProjectId: '1' })
    expandChats()

    expect(
      screen.getByText('No chats yet. Start one with the New Chat button.')
    ).toBeInTheDocument()
  })

  it('opens/resumes the chat when a chat row is clicked (no active-worktree sync)', async () => {
    useAcpStore.setState({ sessionIndex: [chatEntry()] })
    renderWithRouter({ projects: projectWithChats, activeProjectId: '1' })
    expandChats()

    fireEvent.click(screen.getByText('Refactor sidebar'))

    await waitFor(() => {
      expect(mockOpenHistorySession).toHaveBeenCalledWith('chat-1')
      expect(mockAddAgentChatTab).toHaveBeenCalledWith('chat-1')
    })
    // Chat row click must not route through the worktree terminal path.
    expect(mockActivateAndOpenTerminal).not.toHaveBeenCalled()
  })

  it('opens a terminal at the chat cwd via openTerminalAtCwd when the terminal icon is clicked', async () => {
    useAcpStore.setState({ sessionIndex: [chatEntry({ cwd: '/repo/main' })] })
    renderWithRouter({ projects: projectWithChats, activeProjectId: '1' })
    expandChats()

    fireEvent.click(screen.getByLabelText('Open terminal for chat Refactor sidebar'))

    await waitFor(() => {
      expect(mockOpenTerminalAtCwd).toHaveBeenCalledWith('1', '/repo/main')
    })
    // The chat terminal icon must not sync activeWorktreeId (no activateAndOpenTerminal).
    expect(mockActivateAndOpenTerminal).not.toHaveBeenCalled()
  })

  it('keeps the New Worktree action on the project header context menu', async () => {
    const projectGit: Project[] = [
      { id: '1', name: 'Project One', color: 'blue', gitBranch: 'main', isGitRepo: true }
    ]
    renderWithRouter({ projects: projectGit, activeProjectId: '1' })

    fireEvent.contextMenu(screen.getByText('Project One'))
    expect(screen.getByText('New Worktree')).toBeInTheDocument()
  })
})

describe('ProjectSidebar Project Search', () => {
  // 8 projects crosses the PROJECT_SEARCH_THRESHOLD so the search UI renders.
  const manyProjects: Project[] = Array.from({ length: 8 }, (_, i) => ({
    id: String(i + 1),
    name: `Project ${i + 1}`,
    color: 'blue' as const,
    gitBranch: i === 7 ? 'feature/special' : 'main'
  }))

  const fewProjects: Project[] = [
    { id: '1', name: 'Alpha', color: 'blue', gitBranch: 'main' },
    { id: '2', name: 'Beta', color: 'green', gitBranch: 'main' }
  ]

  it('hides the search box when the project count is below the threshold', () => {
    renderWithRouter({ projects: fewProjects, activeProjectId: '1' })
    expect(screen.queryByTestId('project-search-input')).not.toBeInTheDocument()
  })

  it('shows the search box once the project count reaches the threshold', () => {
    renderWithRouter({ projects: manyProjects, activeProjectId: '1' })
    expect(screen.getByTestId('project-search-input')).toBeInTheDocument()
  })

  it('filters the visible projects by name', () => {
    renderWithRouter({ projects: manyProjects, activeProjectId: '1' })

    fireEvent.change(screen.getByTestId('project-search-input'), {
      target: { value: 'Project 8' }
    })

    expect(screen.getByText('Project 8')).toBeInTheDocument()
    expect(screen.queryByText('Project 1')).not.toBeInTheDocument()
    expect(screen.queryByText('Project 2')).not.toBeInTheDocument()
  })

  it('matches on git branch as well as name', () => {
    renderWithRouter({ projects: manyProjects, activeProjectId: '1' })

    fireEvent.change(screen.getByTestId('project-search-input'), {
      target: { value: 'feature/special' }
    })

    expect(screen.getByText('Project 8')).toBeInTheDocument()
    expect(screen.queryByText('Project 1')).not.toBeInTheDocument()
  })

  it('shows an empty state when nothing matches', () => {
    renderWithRouter({ projects: manyProjects, activeProjectId: '1' })

    fireEvent.change(screen.getByTestId('project-search-input'), {
      target: { value: 'no-such-project' }
    })

    expect(screen.getByTestId('project-search-empty')).toBeInTheDocument()
    expect(screen.getByText('No projects found')).toBeInTheDocument()
  })

  it('clears the query when the clear button is clicked', () => {
    renderWithRouter({ projects: manyProjects, activeProjectId: '1' })

    const input = screen.getByTestId('project-search-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Project 8' } })
    expect(screen.queryByText('Project 1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-search-clear'))

    expect(input.value).toBe('')
    expect(screen.getByText('Project 1')).toBeInTheDocument()
  })

  it('clears the query when Escape is pressed in the search box', () => {
    renderWithRouter({ projects: manyProjects, activeProjectId: '1' })

    const input = screen.getByTestId('project-search-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Project 8' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input.value).toBe('')
    expect(screen.getByText('Project 1')).toBeInTheDocument()
  })

  it('keeps the Ctrl+1 shortcut badge tied to the unfiltered position while searching', () => {
    renderWithRouter({ projects: manyProjects, activeProjectId: '1' })

    // Project 1 is index 0 -> Ctrl+1. Search for it; the badge must stay Ctrl+1.
    fireEvent.change(screen.getByTestId('project-search-input'), {
      target: { value: 'Project 1' }
    })

    expect(screen.getByText('Project 1')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+1')).toBeInTheDocument()
  })

  it('clears a lingering query when the search box drops below the threshold', () => {
    const { rerender } = render(
      <MemoryRouter>
        <ProjectSidebar {...defaultProps} projects={manyProjects} activeProjectId="1" />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByTestId('project-search-input'), {
      target: { value: 'Project 8' }
    })
    expect(screen.queryByText('Project 1')).not.toBeInTheDocument()

    // Drop below the threshold so the search box unmounts.
    rerender(
      <MemoryRouter>
        <ProjectSidebar {...defaultProps} projects={fewProjects} activeProjectId="1" />
      </MemoryRouter>
    )

    // No stuck filter: the search box is gone and the remaining projects are visible.
    expect(screen.queryByTestId('project-search-input')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('clears the search when the active project is not in the filtered results', () => {
    const { rerender } = render(
      <MemoryRouter>
        <ProjectSidebar {...defaultProps} projects={manyProjects} activeProjectId="1" />
      </MemoryRouter>
    )

    // Filter to a single project that is NOT the active one.
    fireEvent.change(screen.getByTestId('project-search-input'), {
      target: { value: 'Project 8' }
    })
    expect(screen.queryByText('Project 2')).not.toBeInTheDocument()

    // Active project switches to one hidden by the query (e.g. Ctrl+2 or a new project).
    rerender(
      <MemoryRouter>
        <ProjectSidebar {...defaultProps} projects={manyProjects} activeProjectId="2" />
      </MemoryRouter>
    )

    // Search self-clears so the now-active project is visible again.
    expect((screen.getByTestId('project-search-input') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Project 2')).toBeInTheDocument()
  })

  it('disables the archived toggle while searching', () => {
    const withArchived: Project[] = [
      ...manyProjects,
      { id: '99', name: 'Old Project', color: 'gray', gitBranch: 'main', isArchived: true }
    ]
    renderWithRouter({ projects: withArchived, activeProjectId: '1' })

    fireEvent.change(screen.getByTestId('project-search-input'), {
      target: { value: 'Project' }
    })

    const toggle = screen.getByLabelText(/Archived projects/)
    expect(toggle).toBeDisabled()
  })
})

describe('ProjectSidebar Chat Search', () => {
  const projectWithChats: Project[] = [
    { id: '1', name: 'Project One', color: 'blue', gitBranch: 'main' }
  ]

  const chats: SessionIndexEntry[] = Array.from({ length: 3 }, (_, i) => ({
    id: `chat-${i}`,
    agentId: 'agent-1',
    title: `Chat ${i}`,
    cwd: '/repo/main',
    projectId: '1',
    createdAt: 1000 + i,
    lastActivityAt: 2000 + i,
    messageCount: i,
    status: 'active' as const
  }))

  it('shows the per-project chat search box once a project is expanded', () => {
    useAcpStore.setState({ sessionIndex: chats })
    renderWithRouter({ projects: projectWithChats, activeProjectId: '1' })
    expandChats()

    expect(screen.getByLabelText('Search chats')).toBeInTheDocument()
  })

  it('filters this project chats by title', () => {
    useAcpStore.setState({ sessionIndex: chats })
    renderWithRouter({ projects: projectWithChats, activeProjectId: '1' })
    expandChats()

    fireEvent.change(screen.getByLabelText('Search chats'), {
      target: { value: 'Chat 1' }
    })

    expect(screen.getByText('Chat 1')).toBeInTheDocument()
    expect(screen.queryByText('Chat 0')).not.toBeInTheDocument()
    expect(screen.queryByText('Chat 2')).not.toBeInTheDocument()
  })

  it('clears the chat query on Escape', () => {
    useAcpStore.setState({ sessionIndex: chats })
    renderWithRouter({ projects: projectWithChats, activeProjectId: '1' })
    expandChats()

    const input = screen.getByLabelText('Search chats') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Chat 1' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input.value).toBe('')
    expect(screen.getByText('Chat 0')).toBeInTheDocument()
  })
})

describe('ProjectSidebar Folder Grouping', () => {
  beforeEach(() => {
    // Reset groups in the store before each test
    useProjectStore.setState({ groups: [] })
  })

  it('should render active projects grouped under folder section when groups are configured', () => {
    useProjectStore.setState({
      groups: [
        {
          id: 'group-1',
          name: 'My Folder',
          projectIds: ['1'],
          isCollapsed: false
        }
      ]
    })

    renderWithRouter()

    // Folder header should be visible
    expect(screen.getByText('My Folder')).toBeInTheDocument()
    // Project One (id: 1) should be nested inside the folder
    expect(screen.getByText('Project One')).toBeInTheDocument()
  })

  it('should hide folder contents when group is collapsed', async () => {
    useProjectStore.setState({
      groups: [
        {
          id: 'group-1',
          name: 'My Folder',
          projectIds: ['1'],
          isCollapsed: true
        }
      ]
    })

    renderWithRouter()

    expect(screen.getByText('My Folder')).toBeInTheDocument()
    // Since it is collapsed, Project One should NOT be rendered
    expect(screen.queryByText('Project One')).not.toBeInTheDocument()
  })

  it('should support custom folder group colors', () => {
    useProjectStore.setState({
      groups: [
        {
          id: 'group-1',
          name: 'My Folder',
          projectIds: ['1'],
          isCollapsed: false,
          color: 'purple'
        }
      ]
    })

    renderWithRouter()

    const folderHeader = screen.getByRole('button', { name: /My Folder/i })
    const iconContainer = folderHeader.querySelector('.text-project-purple')
    expect(iconContainer).toBeInTheDocument()
  })
})
