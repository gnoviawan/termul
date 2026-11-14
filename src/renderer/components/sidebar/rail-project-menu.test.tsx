import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RailWorktreeSwitcherProvider } from '@/components/shell/rail/worktree-switcher'
import { TooltipProvider } from '@/components/ui/tooltip'
import { logFrontendError } from '@/lib/log-api'
import { useProjectStore } from '@/stores/project-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Project } from '@/types/project'
import { ProjectSidebar } from '../ProjectSidebar'

/**
 * Sidebar V2 P4: the Rail project row menu (Switch worktree, the "…" button,
 * the context-menu keys), the picked worktree chip, and Import chats in the
 * Projects `+` menu.
 */

const mocks = vi.hoisted(() => ({ admits: { value: true } }))

vi.mock('@/lib/api', () => ({
  dialogApi: { selectDirectory: vi.fn() },
  shellApi: {
    getAvailableShells: vi.fn().mockResolvedValue({
      success: true,
      data: { default: null, available: [] }
    })
  },
  worktreeApi: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
  persistenceApi: {
    read: vi.fn().mockResolvedValue({ success: false, error: 'none', code: 'KEY_NOT_FOUND' }),
    writeDebounced: vi.fn().mockResolvedValue({ success: true })
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => mocks.admits.value
}))
vi.mock('@/components/ui/context-menu', () => import('@/lib/test-utils/context-menu'))
vi.mock('@/components/chat/ImportChatsDialog', () => ({
  ImportChatsDialog: ({
    open,
    cwd,
    projectId
  }: {
    open: boolean
    cwd: string
    projectId: string
  }) =>
    open ? (
      <div role="dialog" aria-label="Import chats" data-cwd={cwd} data-project={projectId} />
    ) : null
}))

const WORKTREE = {
  id: 'a',
  name: 'a',
  branch: 'feat/a',
  path: '/repo/one/.termul/worktrees/a',
  createdAt: '2026-01-01T00:00:00.000Z'
}

const projects: Project[] = [
  {
    id: '1',
    name: 'Project One',
    color: 'blue',
    path: '/repo/one',
    isGitRepo: true,
    gitBranch: 'main',
    worktrees: [WORKTREE]
  },
  { id: '2', name: 'Project Two', color: 'green', path: '/repo/two', isGitRepo: false }
]

function renderSidebar(props: Partial<React.ComponentProps<typeof ProjectSidebar>> = {}) {
  useProjectStore.setState({ projects, groups: [] })
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <RailWorktreeSwitcherProvider>
          <ProjectSidebar
            projects={projects}
            activeProjectId="1"
            onSelectProject={vi.fn()}
            onNewProject={vi.fn()}
            onUpdateProject={vi.fn()}
            onDeleteProject={vi.fn()}
            onArchiveProject={vi.fn()}
            onRestoreProject={vi.fn()}
            onReorderProjects={vi.fn()}
            {...props}
          />
        </RailWorktreeSwitcherProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
}

const row = (id: string): HTMLElement =>
  within(screen.getByTestId(`project-item-${id}`)).getAllByRole('button')[0] as HTMLElement

beforeEach(() => {
  mocks.admits.value = true
  vi.mocked(logFrontendError).mockClear()
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'ready' })
})

afterEach(() => {
  useProjectStore.setState({ projects: [], groups: [] })
})

describe('Rail project row menu', () => {
  it('offers Switch worktree, disabled for a project without git', () => {
    renderSidebar()
    fireEvent.contextMenu(row('1'))
    expect(screen.getByRole('menuitem', { name: /Switch worktree/ })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.contextMenu(row('2'))
    expect(screen.getByRole('menuitem', { name: /Switch worktree/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  it('opens the switcher on the row; picking a worktree shows the chip and logs', async () => {
    renderSidebar()
    expect(screen.queryByTestId('rail-worktree-chip-1')).not.toBeInTheDocument()

    fireEvent.contextMenu(row('1'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Switch worktree/ }))
    const list = await screen.findByRole('listbox', { name: 'Working copies' })
    fireEvent.click(within(list).getByRole('option', { name: /feat\/a/ }))

    expect(useShellLayoutStore.getState().worktreePickByProject['1']).toBeDefined()
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Working copies' })).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('rail-worktree-chip-1')).toHaveTextContent('feat/a')
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ message: '[rail] worktree switch for project 1: a worktree' })
    )
  })

  it('opens the same menu from the row "…" button', () => {
    renderSidebar()
    const more = screen.getByRole('button', { name: 'More actions for Project One' })
    expect(more).toHaveAttribute('aria-haspopup', 'menu')
    expect(
      within(screen.getByTestId('project-item-1')).getByTestId('project-row-actions')
    ).toContainElement(more)
    fireEvent.click(more)
    expect(screen.getByRole('menuitem', { name: /Switch worktree/ })).toBeInTheDocument()
  })

  it.each([
    { key: 'F10', shiftKey: true },
    { key: 'ContextMenu', shiftKey: false }
  ])('opens the menu with $key on the focused row', (keys) => {
    renderSidebar()
    fireEvent.keyDown(row('1'), keys)
    expect(screen.getByRole('menuitem', { name: /Switch worktree/ })).toBeInTheDocument()
  })
})

describe('Projects + menu: Import chats', () => {
  const openMenu = async (): Promise<void> => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add project or folder group' }), {
      key: 'Enter'
    })
    await screen.findByRole('menuitem', { name: 'New project' })
  }

  it('opens the import dialog for the open project working copy, and logs', async () => {
    useShellLayoutStore.setState({ worktreePickByProject: { '1': WORKTREE.path } })
    renderSidebar()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import chats' }))

    const dialog = await screen.findByRole('dialog', { name: 'Import chats' })
    expect(dialog).toHaveAttribute('data-project', '1')
    expect(dialog).toHaveAttribute('data-cwd', WORKTREE.path)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ message: '[rail] chat import started for project 1' })
    )
  })

  it('is disabled with the reason on a read-only server', async () => {
    mocks.admits.value = false
    renderSidebar()
    await openMenu()
    const item = screen.getByRole('menuitem', { name: /Import chats/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    await act(async () => {
      fireEvent.click(item)
    })
    expect(screen.queryByRole('dialog', { name: 'Import chats' })).not.toBeInTheDocument()
  })

  it('is absent without an open project', async () => {
    renderSidebar({ activeProjectId: '' })
    await openMenu()
    expect(screen.queryByRole('menuitem', { name: /Import chats/ })).not.toBeInTheDocument()
  })
})
