import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ProjectSidebar } from './ProjectSidebar'
import type { Project } from '@/types/project'

// Mock the shell API
const mockGetAvailableShells = vi.fn()
vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual('@/lib/utils')
  return { ...actual }
})

// Setup window.api mock
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
  // @ts-expect-error - mock window.api
  window.api = {
    shell: {
      getAvailableShells: mockGetAvailableShells
    }
  }
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

  it('should call onNewProject when New Project is clicked', () => {
    const onNewProject = vi.fn()
    renderWithRouter({ onNewProject })

    fireEvent.click(screen.getByText('New Project'))

    expect(onNewProject).toHaveBeenCalled()
  })

  it('should show empty state when no projects', () => {
    renderWithRouter({ projects: [] })

    expect(screen.getByText('No projects yet')).toBeInTheDocument()
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
      expect(screen.getByText('Set Default Shell')).toBeInTheDocument()
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

    // Hover over Set Default Shell to show submenu
    const shellMenuItem = await screen.findByText('Set Default Shell')
    fireEvent.mouseEnter(shellMenuItem.closest('div')!)

    // Click on Zsh in submenu
    await waitFor(() => {
      expect(screen.getByText('Zsh')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Zsh'))

    expect(onUpdateProject).toHaveBeenCalledWith('1', { defaultShell: 'zsh' })
  })
})
