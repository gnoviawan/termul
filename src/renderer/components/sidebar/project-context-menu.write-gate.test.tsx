import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { expectNotWriteGated, expectWriteGated } from '@/lib/test-utils/write-gate'
import { READ_ONLY_SERVER_REASON } from '@/lib/write-gate'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import type { Project } from '@/types/project'

const admits = vi.hoisted(() => ({ value: false }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => admits.value
}))

import { ProjectContextMenuContent } from './project-context-menu'

const onNewWorktree = vi.fn()

function renderMenu(project: Project) {
  render(
    <ContextMenu>
      <ContextMenuTrigger>
        <div>project row</div>
      </ContextMenuTrigger>
      <ProjectContextMenuContent
        project={project}
        groups={[]}
        availableShells={null}
        onStartRename={vi.fn()}
        onOpenColorPicker={vi.fn()}
        onUpdateProject={vi.fn()}
        moveProjectToGroup={vi.fn()}
        onCreateGroupForProject={vi.fn()}
        onNewWorktree={onNewWorktree}
        onArchiveProject={vi.fn()}
        onConfirmDelete={vi.fn()}
      />
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByText('project row'))
}

const gitProject: Project = { id: 'p1', name: 'P', color: 'blue', isGitRepo: true }

describe('ProjectContextMenuContent write gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    admits.value = false
  })

  it('New Worktree is disabled with the read-only reason on a read-only server', async () => {
    renderMenu(gitProject)
    const item = await screen.findByRole('menuitem', { name: /New Worktree/ })
    expectWriteGated(item)
    expect(item).toHaveTextContent(READ_ONLY_SERVER_REASON)
    fireEvent.click(item)
    expect(onNewWorktree).not.toHaveBeenCalled()
  })

  it('New Worktree stays enabled and unwrapped when writes are admitted', async () => {
    admits.value = true
    renderMenu(gitProject)
    const item = await screen.findByRole('menuitem', { name: /New Worktree/ })
    expectNotWriteGated(item)
    fireEvent.click(item)
    expect(onNewWorktree).toHaveBeenCalledWith('p1')
  })

  it('a non-git project keeps the existing no-git-repo disabled item without the reason', async () => {
    admits.value = false
    renderMenu({ ...gitProject, isGitRepo: false })
    const item = await screen.findByRole('menuitem', { name: /no git repo/ })
    expect(item).toHaveAttribute('data-disabled')
    expect(item.closest('[data-write-gate]')).toBeNull()
  })
})

describe('ProjectContextMenuContent Settings', () => {
  it('opens Project Settings for the right-clicked project without selecting it', async () => {
    useSettingsModalStore.setState({ view: null, projectId: null })
    renderMenu({ ...gitProject, id: 'not-active' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Settings/ }))

    expect(useSettingsModalStore.getState()).toMatchObject({
      view: 'project',
      projectId: 'not-active'
    })
  })
})
