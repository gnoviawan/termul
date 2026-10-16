import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitStatusStore } from '@/stores/git-status-store'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'
import { ProjectSidebar } from './ProjectSidebar'

const {
  mockSelectDirectory,
  toastMock,
  mockGetAvailableShells,
  mockUseProjectsWithActivity,
  mockUseProjectsWithErrors,
  mockUseProjectsWithActiveAgentChat
} = vi.hoisted(() => ({
  mockSelectDirectory: vi.fn(),
  toastMock: Object.assign(vi.fn(), { error: vi.fn() }),
  mockGetAvailableShells: vi.fn(),
  mockUseProjectsWithActivity: vi.fn(),
  mockUseProjectsWithErrors: vi.fn(),
  mockUseProjectsWithActiveAgentChat: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  dialogApi: {
    selectDirectory: mockSelectDirectory
  },
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

vi.mock('sonner', () => ({ toast: toastMock }))

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

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual('@/lib/utils')
  return { ...actual }
})

vi.mock('@/components/ui/context-menu', () => import('@/lib/test-utils/context-menu'))

// Setup mock data
beforeEach(() => {
  mockGetAvailableShells.mockReset()
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
// reverted in handleRowContextMenu, these tests fail
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

  it('scrolls the Add Project submenu so projects below the window stay reachable', () => {
    const projects: Project[] = Array.from({ length: 24 }, (_, index) => ({
      id: String(index + 1),
      name: `Project ${index + 1}`,
      color: 'blue',
      gitBranch: 'main'
    }))
    useProjectStore.setState({
      groups: [{ id: 'group-1', name: 'My Folder', projectIds: ['1'], isCollapsed: false }]
    })
    renderWithRouter({ projects })

    fireEvent.contextMenu(screen.getByText('My Folder'))
    fireEvent.mouseEnter(screen.getByText('Add Project').closest('div')!)

    const submenu = screen.getByTestId('add-project-submenu')
    expect(submenu.style.maxHeight).toBe('var(--radix-popper-available-height, 70vh)')
    expect(submenu.style.overflowY).toBe('auto')
    expect(submenu).toHaveClass('overscroll-contain')

    const lastProject = screen.getByRole('menuitemcheckbox', { name: 'Project 24' })
    expect(submenu).toContainElement(lastProject)
    expect(submenu).toContainElement(screen.getByText('Import Project...'))
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

  it('renders the Projects section flat on the Rail surface with a label-panel header', () => {
    const { container } = renderWithRouter({})

    // No fill of its own: it inherits the Rail's sidebar surface.
    const root = container.firstElementChild
    expect(root).not.toHaveClass('bg-background')
    expect(root).not.toHaveClass('bg-sidebar')
    expect(screen.getByText('Projects')).toHaveClass('label-panel')
    expect(screen.getByRole('button', { name: 'Add project or folder group' })).toHaveClass(
      'size-7'
    )
  })

  it('marks the active project row with keycap and idle rows with a hover wash', () => {
    renderWithRouter({ activeProjectId: '1' })

    const activeRow = screen.getByTestId('project-item-1').querySelector('[role="button"]')
    const idleRow = screen.getByTestId('project-item-2').querySelector('[role="button"]')
    expect(activeRow).toHaveClass('keycap', 'h-8', 'rounded-lg')
    expect(activeRow).not.toHaveClass('bg-sidebar-accent')
    expect(idleRow).not.toHaveClass('keycap')
    // The wash shows under the same conditions as the actions it sits under.
    expect(idleRow).toHaveClass('hover:bg-row-hover', 'focus-within:bg-row-hover')
  })

  it('ends the actions fade in the row surface: keycap when active, the hover wash otherwise', () => {
    renderWithRouter({ activeProjectId: '1' })

    const activeActions = within(screen.getByTestId('project-item-1')).getByTestId(
      'project-row-actions'
    )
    const idleActions = within(screen.getByTestId('project-item-2')).getByTestId(
      'project-row-actions'
    )
    expect(activeActions).toHaveClass('from-[var(--rail-keycap)]')
    expect(idleActions).toHaveClass('from-row-hover-solid')
    expect(idleActions).toHaveClass('group-hover:flex', 'group-focus-within:flex')
  })

  it('shows a "Crashed" mark (no pulse) on a project with a crashed terminal', () => {
    mockUseProjectsWithErrors.mockReturnValue(new Set(['2']))
    renderWithRouter({})

    const mark = within(screen.getByTestId('project-item-2')).getByTitle('Terminal crashed')
    expect(mark).toHaveTextContent('Crashed')
    expect(mark.className).not.toContain('animate-pulse')
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

describe('ProjectSidebar Project Icons', () => {
  it('shows the project identity glyph on active projects', () => {
    renderWithRouter()

    const projectRow = screen.getByTestId('project-item-1')
    // Unresolved projects render the colored monogram tile; the folder glyph
    // is gone from project rows entirely (spec-project-icon).
    const monogram = projectRow.querySelector('[data-project-color="blue"]')
    expect(monogram).toBeInTheDocument()
    expect(monogram).toHaveTextContent('P')
    expect(projectRow.querySelector('svg[data-termul-icon="Folder"]')).not.toBeInTheDocument()
    expect(projectRow.querySelector('svg[data-termul-icon="FolderOpen"]')).not.toBeInTheDocument()
  })

  it('carries the project color on the monogram tile before the name', () => {
    renderWithRouter()

    const projectRow = screen.getByTestId('project-item-1')
    const tile = projectRow.querySelector('[data-project-color="blue"]')
    expect(tile).toHaveClass('rounded', 'bg-project-blue')
    expect(projectRow.querySelector('[role="button"]')).not.toHaveClass('border-l-2')
  })

  it('shows the project identity glyph on archived projects', () => {
    renderWithRouter({
      projects: [
        { id: '1', name: 'Active Project', color: 'blue', gitBranch: 'main' },
        {
          id: '2',
          name: 'Archived Project',
          color: 'green',
          gitBranch: 'develop',
          isArchived: true
        }
      ]
    })

    fireEvent.click(screen.getByText(/Archived \(1\)/))

    const projectRow = screen.getByTestId('archived-project-item-2')
    const monogram = projectRow.querySelector('[data-project-color="green"]')
    expect(monogram).toBeInTheDocument()
    expect(monogram).toHaveTextContent('A')
    expect(projectRow.querySelector('svg[data-termul-icon="Folder"]')).not.toBeInTheDocument()
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

describe('ProjectSidebar Project Context Menu actions', () => {
  it('keeps the New Worktree action on the project header context menu', async () => {
    const projectGit: Project[] = [
      { id: '1', name: 'Project One', color: 'blue', gitBranch: 'main', isGitRepo: true }
    ]
    renderWithRouter({ projects: projectGit, activeProjectId: '1' })

    fireEvent.contextMenu(screen.getByText('Project One'))
    expect(screen.getByText('New Worktree')).toBeInTheDocument()
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
          projectIds: [],
          isCollapsed: true,
          color: 'purple'
        }
      ]
    })

    renderWithRouter()

    const iconContainer = screen
      .getByTestId('rail-group-row-group-1')
      .querySelector('.text-project-purple')
    expect(iconContainer).toBeInTheDocument()
  })
})

describe('ProjectSidebar rail rows', () => {
  const gitProjects: Project[] = [
    { id: '1', name: 'Project One', color: 'blue', path: '/repo/one', isGitRepo: true },
    { id: '2', name: 'Project Two', color: 'green', path: '/repo/two', isGitRepo: true },
    { id: '3', name: 'Plain Folder', color: 'red', path: '/repo/plain', isGitRepo: false }
  ]
  const unwatch = vi.fn()
  const watchDiffStat = vi.fn(() => unwatch)
  const refreshDiffStat = vi.fn(() => Promise.resolve())
  const originalGitState = useGitStatusStore.getState()

  beforeEach(() => {
    unwatch.mockClear()
    watchDiffStat.mockClear()
    refreshDiffStat.mockClear()
    useGitStatusStore.setState({
      diffStats: {},
      watchDiffStat,
      refreshDiffStat
    })
  })

  afterEach(() => {
    useGitStatusStore.setState({
      diffStats: originalGitState.diffStats,
      watchDiffStat: originalGitState.watchDiffStat,
      refreshDiffStat: originalGitState.refreshDiffStat
    })
  })

  it('has no chat chevrons, chat lists or version footer, and one + menu', () => {
    renderWithRouter({ projects: gitProjects })

    expect(screen.queryByLabelText('Expand chats')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Collapse chats')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-footer')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add project or folder group' })).toHaveLength(1)
    expect(screen.queryByLabelText('Create new group folder')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Create new project from header')).not.toBeInTheDocument()
    expect(screen.getByText('Projects')).toBeInTheDocument()
  })

  it('has no panel toggle in the Projects header (the Rail header owns them)', () => {
    // jsdom is web: the old web-only Rail toggle used to render here.
    renderWithRouter({ projects: gitProjects })

    expect(screen.queryByRole('button', { name: 'Expand or collapse projects' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hide sidebar' })).toBeNull()
  })

  it('the + menu offers New project and New folder group', async () => {
    const onNewProject = vi.fn()
    renderWithRouter({ projects: gitProjects, onNewProject })

    const trigger = screen.getByRole('button', { name: 'Add project or folder group' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New project' }))
    expect(onNewProject).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New folder group' }))
    expect(await screen.findByText('Create New Group')).toBeInTheDocument()
  })

  it('shows +N −M at rest, and on hover overlays gear + chip without reflowing the row', () => {
    useGitStatusStore.setState({ diffStats: { '/repo/two': { added: 3, removed: 1 } } })
    renderWithRouter({ projects: gitProjects })

    const row = screen.getByTestId('project-item-2')
    const stat = within(row).getByTestId('project-diff-stat')
    expect(stat).toHaveTextContent('+3 −1')
    // The stat keeps its place; the actions sit on top of the name box's end.
    expect(stat.parentElement).not.toHaveClass('group-hover:hidden')
    const actions = within(row).getByTestId('project-row-actions')
    expect(actions).toHaveClass('absolute', 'hidden', 'group-hover:flex', 'group-focus-within:flex')
    expect(actions).toContainElement(within(row).getByLabelText('Settings for Project Two'))
    expect(actions.parentElement).toContainElement(stat)
  })

  it('shows one side only for a one-sided stat and nothing for a clean tree', () => {
    useGitStatusStore.setState({
      diffStats: { '/repo/one': { added: 2, removed: 0 }, '/repo/two': { added: 0, removed: 0 } }
    })
    renderWithRouter({ projects: gitProjects })

    expect(
      within(screen.getByTestId('project-item-1')).getByTestId('project-diff-stat')
    ).toHaveTextContent(/^\+2$/)
    expect(
      within(screen.getByTestId('project-item-2')).queryByTestId('project-diff-stat')
    ).not.toBeInTheDocument()
  })

  it('hides the gear and chip on an active row at rest, so the name keeps the room', () => {
    renderWithRouter({ projects: gitProjects, activeProjectId: '1' })

    const gear = within(screen.getByTestId('project-item-1')).getByLabelText(
      'Settings for Project One'
    )
    expect(gear.parentElement).toHaveClass('hidden', 'group-hover:flex', 'group-focus-within:flex')
  })

  it('watches each git project, refreshes right after, and unwatches on unmount', () => {
    const { unmount } = renderWithRouter({ projects: gitProjects })

    expect(watchDiffStat).toHaveBeenCalledTimes(2)
    expect(watchDiffStat).toHaveBeenCalledWith('/repo/one')
    expect(watchDiffStat).toHaveBeenCalledWith('/repo/two')
    expect(refreshDiffStat).toHaveBeenCalledWith('/repo/one')
    expect(refreshDiffStat).toHaveBeenCalledWith('/repo/two')
    expect(watchDiffStat.mock.invocationCallOrder[0]).toBeLessThan(
      refreshDiffStat.mock.invocationCallOrder[0]
    )

    unmount()
    expect(unwatch).toHaveBeenCalledTimes(2)
  })

  it('does not watch a non-git project and shows no stat for it', () => {
    useGitStatusStore.setState({ diffStats: { '/repo/plain': { added: 9, removed: 9 } } })
    renderWithRouter({ projects: gitProjects })

    expect(watchDiffStat).not.toHaveBeenCalledWith('/repo/plain')
    expect(
      within(screen.getByTestId('project-item-3')).queryByTestId('project-diff-stat')
    ).not.toBeInTheDocument()
  })

  it('shows nothing and keeps the row when the stat is missing (failed refresh)', () => {
    renderWithRouter({ projects: gitProjects })

    expect(screen.queryByTestId('project-diff-stat')).not.toBeInTheDocument()
    expect(screen.getByText('Project One')).toBeInTheDocument()
  })

  it('does not run the worktree reconciler (the Rail container owns it)', async () => {
    const reconciler = await import('@/lib/worktree-reconciler')
    const spy = vi
      .spyOn(reconciler, 'reconcileProjectWorktrees')
      .mockResolvedValue(undefined as never)
    try {
      renderWithRouter({ projects: gitProjects })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('ProjectSidebar: Mono-style alignment and groups', () => {
  const railProjects: Project[] = Array.from({ length: 10 }, (_, i) => ({
    id: String(i + 1),
    name: `Rail Project ${i + 1}`,
    color: 'blue' as const,
    path: `/repo/rail-${i + 1}`,
    isGitRepo: false
  }))
  const group = (isCollapsed: boolean, ids = ['1', '2']) => ({
    id: 'group-1',
    name: 'My Folder',
    projectIds: ids,
    isCollapsed
  })

  beforeEach(() => {
    useProjectStore.setState({ groups: [] })
  })

  it('has no project search in the Rail, however many projects there are', () => {
    renderWithRouter({ projects: railProjects })
    expect(screen.queryByTestId('project-search-input')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Search projects')).not.toBeInTheDocument()
  })

  it('puts project rows and their icons on the shared Rail column', () => {
    renderWithRouter({ projects: railProjects.slice(0, 2) })

    const row = within(screen.getByTestId('project-item-1')).getByRole('button', {
      name: /Project: Rail Project 1/
    })
    expect(row).toHaveClass('gap-2', 'px-2', 'rounded-lg')
    const iconColumn = row.querySelector('[data-rail-icon-column]')
    expect(iconColumn).toHaveClass('size-4', 'shrink-0')
  })

  it('shows the folder icon at rest and a chevron on hover or focus', () => {
    useProjectStore.setState({ groups: [group(true)] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    const row = screen.getByTestId('rail-group-row-group-1')
    expect(row).toHaveClass('group')
    const icon = row.querySelector('[data-rail-group-icon]')
    const chevron = row.querySelector('[data-rail-group-chevron]')
    // The group's folder icon stands for it, not a child project's icon.
    expect(icon?.querySelector('svg[data-termul-icon="Folder"]')).toBeInTheDocument()
    expect(icon?.querySelector('[data-project-color]')).toBeNull()
    expect(icon).toHaveClass('group-hover:hidden', 'group-focus-within:hidden')
    expect(chevron).toHaveClass(
      'hidden',
      'group-hover:inline-flex',
      'group-focus-within:inline-flex'
    )
    expect(chevron?.querySelector('svg[data-termul-icon="ChevronRight"]')).toBeInTheDocument()
    // The row is one button that toggles the group.
    expect(within(row).getByRole('button', { name: 'My Folder' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    // The shared inset must not override the right padding that keeps the label
    // clear of the absolute-positioned actions button.
    expect(within(row).getByRole('button', { name: 'My Folder' })).toHaveClass('px-2', 'pr-8')
  })

  it('shows a neutral folder icon for an empty group', () => {
    useProjectStore.setState({ groups: [group(true, [])] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    const icon = screen
      .getByTestId('rail-group-row-group-1')
      .querySelector('[data-rail-group-icon]')
    expect(icon?.querySelector('svg[data-termul-icon="Folder"]')).toBeInTheDocument()
  })

  it('keeps the chevron-down visible when expanded and wraps the group in one surface', () => {
    useProjectStore.setState({ groups: [group(false)] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    const row = screen.getByTestId('rail-group-row-group-1')
    const icon = row.querySelector('[data-rail-group-icon]')
    const chevron = row.querySelector('[data-rail-group-chevron]')
    expect(icon).toHaveClass('hidden')
    expect(icon).not.toHaveClass('group-hover:hidden')
    expect(chevron).toHaveClass('inline-flex')
    expect(chevron).not.toHaveClass('hidden')
    expect(chevron?.querySelector('svg[data-termul-icon="ChevronDown"]')).toBeInTheDocument()

    const container = screen.getByTestId('rail-group-group-1')
    expect(container).toHaveClass('rounded-lg', 'bg-foreground/[0.03]')
    // Children sit in the same icon column; the container gives the grouping, not indentation.
    const groupList = container.querySelector('[data-group-container-id="group-1"]')
    expect(groupList).not.toHaveClass('pl-4')
    const childRow = within(screen.getByTestId('project-item-1')).getByRole('button', {
      name: /Project: Rail Project 1/
    })
    expect(childRow).toHaveClass('gap-2', 'px-2')
  })

  it('has no container surface on a collapsed group', () => {
    useProjectStore.setState({ groups: [group(true)] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    expect(screen.getByTestId('rail-group-group-1')).not.toHaveClass('bg-foreground/[0.03]')
  })

  it('toggles the group from the row button', () => {
    useProjectStore.setState({ groups: [group(true)] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    fireEvent.click(screen.getByRole('button', { name: 'My Folder' }))

    expect(useProjectStore.getState().groups?.[0].isCollapsed).toBe(false)
  })

  it('reveals a Tab-reachable more button that opens the group menu', () => {
    useProjectStore.setState({ groups: [group(true)] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    const more = screen.getByRole('button', { name: 'Group actions for My Folder' })
    expect(more).toHaveClass(
      'opacity-0',
      'group-hover:opacity-100',
      'group-focus-within:opacity-100'
    )
    expect(more).not.toHaveAttribute('tabindex', '-1')

    fireEvent.click(more)

    expect(screen.getByText('Rename Group')).toBeInTheDocument()
    expect(screen.getByText('Delete Group (Keep Projects)')).toBeInTheDocument()
  })

  it('opens the same group menu on right-click', () => {
    useProjectStore.setState({ groups: [group(true)] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    fireEvent.contextMenu(screen.getByText('My Folder'))

    expect(screen.getByText('Rename Group')).toBeInTheDocument()
  })

  function importProjectIntoGroup(): void {
    fireEvent.contextMenu(screen.getByText('My Folder'))
    fireEvent.mouseEnter(screen.getByText('Add Project'))
    fireEvent.click(screen.getByText('Import Project...'))
  }

  it('confirms an imported project with a sonner toast', async () => {
    mockSelectDirectory.mockResolvedValue({ success: true, data: '/repo/imported' })
    const addProject = vi.fn().mockResolvedValue({ id: 'imported' })
    useProjectStore.setState({ groups: [group(true)], addProject })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    importProjectIntoGroup()

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('Project created', {
        description: 'Created project "imported" and added to group.'
      })
    )
    expect(addProject).toHaveBeenCalledWith('imported', 'blue', '/repo/imported')
  })

  it('reports a failed project import with a sonner error toast', async () => {
    mockSelectDirectory.mockRejectedValue(new Error('dialog failed'))
    useProjectStore.setState({ groups: [group(true)] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    importProjectIntoGroup()

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Error', {
        description: 'Failed to create project from folder: dialog failed'
      })
    )
  })

  it('renames a group inline from the menu', () => {
    useProjectStore.setState({ groups: [group(true)] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    fireEvent.click(screen.getByRole('button', { name: 'Group actions for My Folder' }))
    fireEvent.click(screen.getByText('Rename Group'))
    const input = screen.getByRole('textbox', { name: 'Rename group My Folder' })
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useProjectStore.getState().groups?.[0].name).toBe('Renamed')
  })

  it('colours the folder icon with the group colour', () => {
    useProjectStore.setState({ groups: [{ ...group(true), color: 'green' }] })
    renderWithRouter({ projects: railProjects.slice(0, 3) })

    const folder = screen
      .getByTestId('rail-group-row-group-1')
      .querySelector('[data-rail-group-icon] svg[data-termul-icon="Folder"]')
    expect(folder).toHaveClass('text-project-green')
  })

  describe('section headers', () => {
    it('shows only the Projects header, with its + menu, when there is no group', () => {
      renderWithRouter({ projects: railProjects.slice(0, 3) })

      expect(screen.getByText('Projects')).toBeInTheDocument()
      expect(screen.queryByText('Groups')).not.toBeInTheDocument()
      expect(screen.queryByTestId('rail-section-groups')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'New group' })).not.toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Add project or folder group' })).toHaveLength(1)
    })

    it('shows Groups and Projects headers once a group exists', () => {
      useProjectStore.setState({ groups: [group(true)] })
      renderWithRouter({ projects: railProjects.slice(0, 3) })

      expect(screen.getByRole('heading', { name: 'Groups' })).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument()
      // One Projects header: the sidebar's own steps aside.
      expect(screen.getAllByText('Projects')).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'New group' })).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Add project or folder group' })).toHaveLength(1)
    })

    it('puts grouped projects under Groups and ungrouped ones under Projects', () => {
      useProjectStore.setState({ groups: [group(false)] })
      renderWithRouter({ projects: railProjects.slice(0, 3) })

      const precedes = (a: Node, b: Node): boolean =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      const groupsHeader = screen.getByTestId('rail-section-groups')
      const projectsHeader = screen.getByTestId('rail-section-projects')
      const grouped = screen.getByTestId('grouped-projects-container')
      const ungrouped = screen.getByTestId('ungrouped-projects-container')

      expect(precedes(groupsHeader, grouped)).toBe(true)
      expect(precedes(grouped, projectsHeader)).toBe(true)
      expect(precedes(projectsHeader, ungrouped)).toBe(true)
      expect(within(grouped).getByTestId('project-item-1')).toBeInTheDocument()
      expect(within(grouped).getByTestId('project-item-2')).toBeInTheDocument()
      expect(within(grouped).queryByTestId('project-item-3')).not.toBeInTheDocument()
      expect(within(ungrouped).getByTestId('project-item-3')).toBeInTheDocument()
    })

    it('keeps the Projects header when every project is grouped', () => {
      useProjectStore.setState({ groups: [group(false, ['1', '2', '3'])] })
      renderWithRouter({ projects: railProjects.slice(0, 3) })

      expect(screen.getByTestId('rail-section-projects')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Add project or folder group' })
      ).toBeInTheDocument()
    })

    it('opens the New group dialog from the Groups +', async () => {
      useProjectStore.setState({ groups: [group(true)] })
      renderWithRouter({ projects: railProjects.slice(0, 3) })

      fireEvent.click(screen.getByRole('button', { name: 'New group' }))

      expect(await screen.findByText('Create New Group')).toBeInTheDocument()
    })

    it('adds a project from the Projects +', async () => {
      const onNewProject = vi.fn()
      useProjectStore.setState({ groups: [group(true)] })
      renderWithRouter({ projects: railProjects.slice(0, 3), onNewProject })

      fireEvent.keyDown(screen.getByRole('button', { name: 'Add project or folder group' }), {
        key: 'Enter'
      })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'New project' }))

      expect(onNewProject).toHaveBeenCalledTimes(1)
    })

    it('keeps both header buttons Tab-reachable and the headers out of the tab order', () => {
      useProjectStore.setState({ groups: [group(true)] })
      renderWithRouter({ projects: railProjects.slice(0, 3) })

      for (const id of ['rail-section-groups', 'rail-section-projects']) {
        const header = screen.getByTestId(id)
        expect(header).not.toHaveAttribute('tabindex')
        const button = within(header).getByRole('button')
        expect(button).not.toHaveAttribute('tabindex', '-1')
      }
    })
  })
})
