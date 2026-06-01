import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ProjectSidebar } from './ProjectSidebar'
import type { Project } from '@/types/project'
import { useProjectStore } from '@/stores/project-store'

const { mockGetAvailableShells, mockSpawnTerminalInPane, mockActivateAndOpenTerminal, mockUseProjectsWithActivity, mockUseProjectsWithErrors } = vi.hoisted(() => ({
  mockGetAvailableShells: vi.fn(),
  mockSpawnTerminalInPane: vi.fn(),
  mockActivateAndOpenTerminal: vi.fn(),
  mockUseProjectsWithActivity: vi.fn(),
  mockUseProjectsWithErrors: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  shellApi: {
    getAvailableShells: mockGetAvailableShells
  },
  worktreeApi: {
    list: vi.fn().mockResolvedValue({ success: true, data: [] }),
    checkDirty: vi.fn().mockResolvedValue({ success: true, data: { modified: 0, staged: 0, untracked: 0, hasChanges: false } }),
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

vi.mock('@/lib/terminal-spawn', () => ({
  spawnTerminalInPane: mockSpawnTerminalInPane,
  activateAndOpenTerminal: mockActivateAndOpenTerminal
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual('@/lib/utils')
  return { ...actual }
})

// Setup mock data
beforeEach(() => {
  mockGetAvailableShells.mockReset()
  mockSpawnTerminalInPane.mockReset()
  mockSpawnTerminalInPane.mockResolvedValue({ success: true, data: { id: 'term-1' } })
  mockActivateAndOpenTerminal.mockReset()
  mockActivateAndOpenTerminal.mockResolvedValue({ status: 'opened', terminalId: 'term-1' })
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

// Worktrees are collapsed by default and only expand via the chevron, so tests
// that assert on worktree rows must open the section first.
const expandWorktrees = () => {
  fireEvent.click(screen.getByLabelText('Expand worktrees'))
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

describe('ProjectSidebar', () => {
  it('should render project list', () => {
    renderWithRouter()

    expect(screen.getByText('Project One')).toBeInTheDocument()
    expect(screen.getByText('Project Two')).toBeInTheDocument()
  })

  it('should render project avatars with first letter', () => {
    renderWithRouter()

    const activeProjectsContainer = screen.getByTestId('active-projects-container')
    const avatars = within(activeProjectsContainer).getAllByTestId('project-avatar-letter')
    const letters = avatars.map((avatar) => avatar.textContent)

    expect(letters).toStrictEqual(['P', 'P'])
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

    // Should show fallback character '?' for empty name
    const avatar = screen.getByTestId('project-avatar-letter')
    expect(avatar).toHaveTextContent('?')
  })

  it('should extract first alphabetic character for emoji project names', () => {
    const projectsWithEmoji: Project[] = [
      { id: '1', name: '🚀Rocket', color: 'blue', gitBranch: 'main' }
    ]
    renderWithRouter({ projects: projectsWithEmoji })

    // Should extract 'R' from Rocket, not the emoji
    const avatar = screen.getByTestId('project-avatar-letter')
    expect(avatar).toHaveTextContent('R')
  })

  it('should preserve emoji-only project names in avatar fallback', () => {
    const projectsWithEmojiOnlyName: Project[] = [
      { id: '1', name: '🚀', color: 'blue', gitBranch: 'main' }
    ]
    renderWithRouter({ projects: projectsWithEmojiOnlyName })

    // Should keep full emoji grapheme as fallback, not a surrogate fragment
    const avatar = screen.getByTestId('project-avatar-letter')
    expect(avatar).toHaveTextContent('🚀')
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

describe('ProjectSidebar Terminal Activity Indicator', () => {
  it('should not show activity indicator when hasActivity is false', () => {
    mockUseProjectsWithActivity.mockReturnValue([])
    renderWithRouter()

    const item = screen.getByTestId('project-item-1')
    const spinner = item.querySelector('svg.animate-spin')
    expect(spinner).toBeNull()
  })

  it('should show activity indicator when hasActivity is true and project is not active', () => {
    mockUseProjectsWithActivity.mockReturnValue(['2'])
    renderWithRouter()

    const item = screen.getByTestId('project-item-2')
    const spinner = item.querySelector('svg.animate-spin')
    expect(spinner).not.toBeNull()

    const wrapper = spinner!.closest('span')
    expect(wrapper).toHaveAttribute('title', 'Terminal activity')
  })

  it('should show activity indicator even when project is active if hasActivity is true', () => {
    mockUseProjectsWithActivity.mockReturnValue(['1'])
    renderWithRouter()

    const item = screen.getByTestId('project-item-1')
    const spinner = item.querySelector('svg.animate-spin')
    expect(spinner).not.toBeNull()
  })
})

describe('ProjectSidebar Worktree Row', () => {
  const projectWithWorktree: Project[] = [
    {
      id: '1',
      name: 'Project One',
      color: 'blue',
      gitBranch: 'main',
      isGitRepo: true,
      worktrees: [
        {
          id: 'wt-1',
          name: 'try-new-hero',
          branch: 'feature/try-new-hero',
          path: '/repo/.termul/worktrees/try-new-hero',
          createdAt: new Date().toISOString()
        }
      ]
    }
  ]

  it('shows the worktree name but not the branch chip on the row face', () => {
    renderWithRouter({ projects: projectWithWorktree, activeProjectId: '1' })
    expandWorktrees()

    // Name is shown
    expect(screen.getByText('try-new-hero')).toBeInTheDocument()
    // Branch is NOT shown as a visible chip on the row
    expect(screen.queryByText('feature/try-new-hero')).not.toBeInTheDocument()
  })

  it('keeps the branch available via the row tooltip', () => {
    renderWithRouter({ projects: projectWithWorktree, activeProjectId: '1' })
    expandWorktrees()

    const row = screen.getByLabelText('Worktree try-new-hero on feature/try-new-hero')
    expect(row).toHaveAttribute('title', expect.stringContaining('feature/try-new-hero'))
  })

  it('exposes an accessible "Open terminal" button on the worktree row', () => {
    renderWithRouter({ projects: projectWithWorktree, activeProjectId: '1' })
    expandWorktrees()

    expect(
      screen.getByLabelText('Open terminal in try-new-hero')
    ).toBeInTheDocument()
  })

  it('opens a terminal in the worktree when the terminal button is clicked, without triggering row select', async () => {
    const onSelectProject = vi.fn()
    renderWithRouter({ projects: projectWithWorktree, activeProjectId: '1', onSelectProject })
    expandWorktrees()

    fireEvent.click(screen.getByLabelText('Open terminal in try-new-hero'))

    await waitFor(() => {
      expect(mockActivateAndOpenTerminal).toHaveBeenCalled()
    })
    // The terminal-button click must not bubble to the project row's select handler
    expect(onSelectProject).not.toHaveBeenCalled()
  })

  it('does not trigger row select when activating the terminal button via keyboard', () => {
    renderWithRouter({ projects: projectWithWorktree, activeProjectId: '1' })
    expandWorktrees()

    const termButton = screen.getByLabelText('Open terminal in try-new-hero')
    // Enter on the nested terminal button must not bubble to the row's onKeyDown select
    fireEvent.keyDown(termButton, { key: 'Enter' })

    // The shared open handler is not invoked by the key event (spawn happens on click)
    expect(mockActivateAndOpenTerminal).not.toHaveBeenCalled()
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

describe('ProjectSidebar Worktree Search', () => {
  // 10+ worktrees crosses the worktree-search threshold.
  const projectWithManyWorktrees: Project[] = [
    {
      id: '1',
      name: 'Big Repo',
      color: 'blue',
      gitBranch: 'main',
      isGitRepo: true,
      worktrees: Array.from({ length: 11 }, (_, i) => ({
        id: `wt-${i}`,
        name: `worktree-${i}`,
        branch: `feature/branch-${i}`,
        path: `/repo/.termul/worktrees/worktree-${i}`,
        createdAt: new Date().toISOString()
      }))
    }
  ]

  it('shows a worktree search box with an icon once there are 10+ worktrees', () => {
    renderWithRouter({ projects: projectWithManyWorktrees, activeProjectId: '1' })
    expandWorktrees()
    expect(screen.getByLabelText('Search worktrees')).toBeInTheDocument()
  })

  it('shows a clear button only after typing, and clears on click', () => {
    renderWithRouter({ projects: projectWithManyWorktrees, activeProjectId: '1' })
    expandWorktrees()

    const input = screen.getByLabelText('Search worktrees') as HTMLInputElement
    expect(screen.queryByLabelText('Clear worktree search')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'worktree-3' } })
    expect(screen.getByLabelText('Clear worktree search')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Clear worktree search'))
    expect(input.value).toBe('')
  })

  it('clears the worktree query on Escape', () => {
    renderWithRouter({ projects: projectWithManyWorktrees, activeProjectId: '1' })
    expandWorktrees()

    const input = screen.getByLabelText('Search worktrees') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'worktree-3' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input.value).toBe('')
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
})
