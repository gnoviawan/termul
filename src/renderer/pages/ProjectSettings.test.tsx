import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import type { Project } from '@/types/project'
import { ProjectSettingsModal } from './ProjectSettings'

const apiMocks = vi.hoisted(() => ({
  selectFile: vi.fn(),
  selectDirectory: vi.fn(),
  readFile: vi.fn(),
  getAvailableShells: vi.fn(),
  parseGitignore: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  dialogApi: {
    selectFile: apiMocks.selectFile,
    selectDirectory: apiMocks.selectDirectory
  },
  filesystemApi: { readFile: apiMocks.readFile },
  shellApi: { getAvailableShells: apiMocks.getAvailableShells },
  worktreeApi: { parseGitignore: apiMocks.parseGitignore }
}))

vi.mock('@/components/settings/SettingsLayout', () => ({
  SettingsLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>
}))

vi.mock('@/components/NewProjectModal', () => ({ NewProjectModal: () => null }))
vi.mock('@/components/ConfirmDialog', () => ({ ConfirmDialog: () => null }))

const firstProject: Project = {
  id: 'project-1',
  name: 'First Project',
  color: 'blue',
  path: '/workspace/app',
  defaultShell: 'bash',
  envVars: [
    { key: 'KEEP', value: 'unchanged' },
    { key: 'OVERWRITE', value: 'old' }
  ]
}

const secondProject: Project = {
  id: 'project-2',
  name: 'Second Project',
  color: 'green',
  path: '/workspace/second',
  defaultShell: 'bash',
  envVars: [{ key: 'SECOND', value: 'saved' }]
}

function renderSettings(projects: Project[] = [firstProject], activeProjectId = firstProject.id) {
  useProjectStore.setState({
    projects,
    groups: [],
    activeProjectId,
    isLoaded: true,
    isWorktreeOperationLocked: false
  })
  useSettingsModalStore.setState({ view: 'project' })

  return render(
    <MemoryRouter>
      <ProjectSettingsModal />
    </MemoryRouter>
  )
}

function importEnv() {
  fireEvent.click(screen.getByRole('button', { name: /import from \.env/i }))
}

describe('ProjectSettings .env import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getAvailableShells.mockResolvedValue({
      success: true,
      data: {
        available: [{ name: 'bash', path: '/bin/bash', displayName: 'Bash' }],
        default: { name: 'bash', path: '/bin/bash', displayName: 'Bash' }
      }
    })
    apiMocks.parseGitignore.mockResolvedValue({ success: true, data: [] })
    apiMocks.selectDirectory.mockResolvedValue({
      success: false,
      error: 'cancelled',
      code: 'DIALOG_CANCELED'
    })
  })

  it('reads the current form root .env directly, merges values, and keeps them unsaved', async () => {
    apiMocks.readFile.mockResolvedValue({
      success: true,
      data: { content: 'OVERWRITE=new\nADDED=value', path: '/workspace/app/.env' }
    })
    renderSettings()

    importEnv()

    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledWith('/workspace/app/.env'))
    expect(apiMocks.selectFile).not.toHaveBeenCalled()
    expect(await screen.findByDisplayValue('new')).toBeInTheDocument()
    expect(screen.getByDisplayValue('unchanged')).toBeInTheDocument()
    expect(screen.getByDisplayValue('value')).toBeInTheDocument()
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument()
    expect(useProjectStore.getState().projects[0].envVars).toEqual(firstProject.envVars)
  })

  it('uses an edited root path and normalizes trailing separators', async () => {
    apiMocks.readFile.mockResolvedValue({
      success: true,
      data: { content: 'KEY=value', path: 'C:\\workspace\\edited\\.env' }
    })
    renderSettings()

    fireEvent.change(screen.getByDisplayValue('/workspace/app'), {
      target: { value: 'C:\\workspace\\edited\\\\' }
    })
    importEnv()

    await waitFor(() =>
      expect(apiMocks.readFile).toHaveBeenCalledWith('C:\\workspace\\edited\\.env')
    )
    expect(apiMocks.selectFile).not.toHaveBeenCalled()
  })

  it('trims surrounding whitespace from the edited root before reading', async () => {
    apiMocks.readFile.mockResolvedValue({
      success: true,
      data: { content: 'KEY=value', path: '/workspace/edited/.env' }
    })
    renderSettings()

    fireEvent.change(screen.getByDisplayValue('/workspace/app'), {
      target: { value: '  /workspace/edited/  ' }
    })
    importEnv()

    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledWith('/workspace/edited/.env'))
  })

  it('requires a configured form root without reading or opening a dialog', async () => {
    renderSettings([{ ...firstProject, path: undefined }])

    importEnv()

    expect(await screen.findByText('Project root is required to import .env.')).toBeInTheDocument()
    expect(apiMocks.readFile).not.toHaveBeenCalled()
    expect(apiMocks.selectFile).not.toHaveBeenCalled()
  })

  it('keeps existing values unchanged and reports adapter read failures', async () => {
    apiMocks.readFile.mockResolvedValue({
      success: false,
      error: 'File not found',
      code: 'FILE_NOT_FOUND'
    })
    renderSettings()

    importEnv()

    expect(await screen.findByText('Failed to read .env: File not found')).toBeInTheDocument()
    expect(screen.getByDisplayValue('old')).toBeInTheDocument()
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument()
    expect(apiMocks.selectFile).not.toHaveBeenCalled()
  })

  it('keeps values unchanged for an empty or comment-only file', async () => {
    apiMocks.readFile.mockResolvedValue({
      success: true,
      data: { content: '# comment\n\n', path: '/workspace/app/.env' }
    })
    renderSettings()

    importEnv()

    expect(await screen.findByText('The .env file is empty.')).toBeInTheDocument()
    expect(screen.getByDisplayValue('old')).toBeInTheDocument()
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument()
  })

  it('reports invalid-only files without marking the form changed', async () => {
    apiMocks.readFile.mockResolvedValue({
      success: true,
      data: { content: 'INVALID LINE', path: '/workspace/app/.env' }
    })
    renderSettings()

    importEnv()

    expect(await screen.findByText(/Imported 0 variables/)).toBeInTheDocument()
    expect(screen.getByText(/Line 1: INVALID LINE/)).toBeInTheDocument()
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument()
  })

  it('imports valid variables and warns about invalid lines', async () => {
    apiMocks.readFile.mockResolvedValue({
      success: true,
      data: { content: 'VALID=value\nINVALID LINE', path: '/workspace/app/.env' }
    })
    renderSettings()

    importEnv()

    expect(await screen.findByDisplayValue('value')).toBeInTheDocument()
    expect(screen.getByText(/Imported 1 variables/)).toBeInTheDocument()
    expect(screen.getByText(/Line 2: INVALID LINE/)).toBeInTheDocument()
  })

  it('discards a completed read after the active project switches', async () => {
    let resolveRead: ((result: unknown) => void) | undefined
    apiMocks.readFile.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve
      })
    )
    renderSettings([firstProject, secondProject])

    importEnv()
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledWith('/workspace/app/.env'))

    act(() => {
      useProjectStore.getState().selectProject(secondProject.id)
    })
    await screen.findByDisplayValue('Second Project')

    await act(async () => {
      resolveRead?.({
        success: true,
        data: { content: 'STALE=ignored', path: '/workspace/app/.env' }
      })
      await Promise.resolve()
    })

    expect(screen.queryByDisplayValue('ignored')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('saved')).toBeInTheDocument()
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument()
    expect(apiMocks.selectFile).not.toHaveBeenCalled()
  })

  it('discards a pending read after the edited root changes', async () => {
    let resolveRead: ((result: unknown) => void) | undefined
    apiMocks.readFile.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve
      })
    )
    renderSettings()

    importEnv()
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledWith('/workspace/app/.env'))
    fireEvent.change(screen.getByDisplayValue('/workspace/app'), {
      target: { value: '/workspace/changed' }
    })

    await act(async () => {
      resolveRead?.({
        success: true,
        data: { content: 'STALE=ignored', path: '/workspace/app/.env' }
      })
      await Promise.resolve()
    })

    expect(screen.queryByDisplayValue('ignored')).not.toBeInTheDocument()
  })

  it('allows only the latest overlapping import to update the form', async () => {
    const resolvers: Array<(result: unknown) => void> = []
    apiMocks.readFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )
    renderSettings()

    importEnv()
    importEnv()
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolvers[1]({ success: true, data: { content: 'ORDER=new', path: '/workspace/app/.env' } })
      await Promise.resolve()
    })
    expect(await screen.findByDisplayValue('new')).toBeInTheDocument()

    await act(async () => {
      resolvers[0]({ success: true, data: { content: 'ORDER=old', path: '/workspace/app/.env' } })
      await Promise.resolve()
    })
    expect(screen.getByDisplayValue('new')).toBeInTheDocument()
    expect(screen.getByDisplayValue('ORDER')).toBeInTheDocument()
  })
})
