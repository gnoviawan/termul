import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import type { Project } from '@/types/project'
import { ProjectSettingsModal } from './ProjectSettings'
import {
  PROJECT_SETTINGS_CATEGORIES,
  PROJECT_SETTINGS_SEARCH_INDEX
} from './project-settings/categories'

const apiMocks = vi.hoisted(() => ({
  selectFile: vi.fn(),
  selectDirectory: vi.fn(),
  readFile: vi.fn(),
  getAvailableShells: vi.fn(),
  parseGitignore: vi.fn()
}))

vi.mock('@/lib/active-project', () => ({ writeActiveProject: vi.fn() }))

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

vi.mock('@/components/settings/BrowserPolicySettings', () => ({
  BrowserProjectPolicy: () => null
}))
vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({
    isOpen,
    confirmLabel,
    onConfirm
  }: {
    isOpen: boolean
    confirmLabel?: string
    onConfirm: () => void
  }) =>
    isOpen ? (
      <button type="button" onClick={onConfirm}>
        {confirmLabel}
      </button>
    ) : null
}))

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

function renderSettings(
  projects: Project[] = [firstProject],
  activeProjectId = firstProject.id,
  settingsProjectId: string | null = null
) {
  useProjectStore.setState({
    projects,
    groups: [],
    activeProjectId,
    isLoaded: true,
    isWorktreeOperationLocked: false
  })
  useSettingsModalStore.setState({ view: 'project', projectId: settingsProjectId })

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
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
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
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
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
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
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
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
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
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
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

describe('ProjectSettings layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getAvailableShells.mockResolvedValue({
      success: true,
      data: {
        available: [
          { name: 'bash', path: '/bin/bash', displayName: 'Bash' },
          { name: 'zsh', path: '/bin/zsh', displayName: 'Zsh' }
        ],
        default: { name: 'bash', path: '/bin/bash', displayName: 'Bash' }
      }
    })
    apiMocks.parseGitignore.mockResolvedValue({ success: true, data: [] })
  })

  it('groups pages like Preferences and leaves Emergency mode out', () => {
    expect(PROJECT_SETTINGS_CATEGORIES.map((c) => [c.group, c.id])).toEqual([
      ['Project', 'general'],
      ['Project', 'shell'],
      ['Project', 'env-vars'],
      ['Project', 'symlinks'],
      ['Agents', 'provider']
    ])
    expect(PROJECT_SETTINGS_SEARCH_INDEX.some((e) => e.categoryId === 'emergency')).toBe(false)
  })

  it('points every search anchor at a rendered settings row', () => {
    renderSettings()

    const anchors = PROJECT_SETTINGS_SEARCH_INDEX.flatMap((e) => (e.anchorId ? [e.anchorId] : []))
    expect(anchors.length).toBeGreaterThan(0)
    for (const anchor of anchors) {
      const row = document.getElementById(anchor)
      expect(row, anchor).not.toBeNull()
      expect(row).toHaveAttribute('data-settings-row')
    }
    expect(screen.queryByText(/skip confirmation/i)).not.toBeInTheDocument()
  })

  it('shows a stored shell name as its detected shell', async () => {
    renderSettings()

    const select = screen.getByRole('combobox', { name: 'Shell' })
    await waitFor(() => expect(select).toHaveTextContent('Bash'))
  })

  it('offers the app default when the project has no shell of its own', async () => {
    renderSettings([{ ...firstProject, defaultShell: undefined }])

    await waitFor(() => expect(apiMocks.getAvailableShells).toHaveBeenCalled())
    expect(screen.getByRole('combobox', { name: 'Shell' })).toHaveTextContent('App default')
  })

  it('labels each list row control and its remove button', () => {
    renderSettings([{ ...firstProject, symlinkDirs: ['node_modules'] }])

    expect(screen.getByRole('textbox', { name: 'Name of KEEP' })).toHaveValue('KEEP')
    expect(screen.getByRole('textbox', { name: 'Value of KEEP' })).toHaveValue('unchanged')
    expect(screen.getByRole('button', { name: 'Remove KEEP' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Path of node_modules' })).toHaveValue(
      'node_modules'
    )
    expect(screen.getByRole('button', { name: 'Remove node_modules' })).toBeInTheDocument()
  })

  it('shows an empty state with both actions when a list is empty', () => {
    renderSettings([{ ...firstProject, envVars: [] }])

    expect(screen.getByText('No environment variables')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /import from \.env/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add variable/i })).toBeInTheDocument()
    expect(screen.getByText('No linked directories')).toBeInTheDocument()
  })
})

describe('ProjectSettings discard', () => {
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
  })

  it('puts every edited field back to the saved project and clears the save bar', async () => {
    renderSettings([{ ...firstProject, symlinkDirs: ['node_modules'] }])

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.change(screen.getByLabelText('Root directory'), {
      target: { value: '/workspace/elsewhere' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Value of KEEP' }), {
      target: { value: 'edited' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove OVERWRITE' }))
    fireEvent.click(screen.getByRole('button', { name: /add variable/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Path of node_modules' }), {
      target: { value: '.venv' }
    })
    fireEvent.click(screen.getByRole('radio', { name: /green/i }))
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(screen.getByLabelText('Name')).toHaveValue('First Project')
    expect(screen.getByLabelText('Root directory')).toHaveValue('/workspace/app')
    expect(screen.getByRole('textbox', { name: 'Value of KEEP' })).toHaveValue('unchanged')
    expect(screen.getByRole('textbox', { name: 'Value of OVERWRITE' })).toHaveValue('old')
    expect(screen.queryByRole('textbox', { name: 'Name of variable 3' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Path of node_modules' })).toHaveValue(
      'node_modules'
    )
    expect(screen.getByRole('radio', { name: /blue/i })).toBeChecked()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(useProjectStore.getState().projects[0]).toMatchObject({
      name: 'First Project',
      path: '/workspace/app',
      envVars: firstProject.envVars
    })
  })

  it('clears .env import messages and ignores a read that lands after discard', async () => {
    let resolveRead: ((result: unknown) => void) | undefined
    apiMocks.readFile.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve
      })
    )
    renderSettings()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    importEnv()
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await act(async () => {
      resolveRead?.({ success: true, data: { content: 'LATE=value', path: '/workspace/app/.env' } })
      await Promise.resolve()
    })

    expect(screen.queryByDisplayValue('LATE')).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('drops unsaved edits when the user leaves through the close prompt', async () => {
    renderSettings()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }))
    expect(useSettingsModalStore.getState().view).not.toBe('project')

    act(() => useSettingsModalStore.getState().openProject())

    expect(await screen.findByLabelText('Name')).toHaveValue('First Project')
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })
})

describe('ProjectSettings for a project that is not active', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getAvailableShells.mockResolvedValue({ success: true, data: null })
    apiMocks.parseGitignore.mockResolvedValue({ success: true, data: [] })
  })

  it('edits the project it was opened for and leaves the active project alone', async () => {
    renderSettings([firstProject, secondProject], firstProject.id, secondProject.id)

    expect(await screen.findByLabelText('Name')).toHaveValue('Second Project')
    expect(screen.getByDisplayValue('/workspace/second')).toBeInTheDocument()
    expect(useProjectStore.getState().activeProjectId).toBe(firstProject.id)
  })

  it('saves to the project it was opened for, not the active one', async () => {
    const updateProject = vi.fn()
    renderSettings([firstProject, secondProject], firstProject.id, secondProject.id)
    useProjectStore.setState({ updateProject })

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(updateProject).toHaveBeenCalledTimes(1)
    expect(updateProject).toHaveBeenCalledWith(
      secondProject.id,
      expect.objectContaining({ name: 'Renamed', path: '/workspace/second' })
    )
    expect(useProjectStore.getState().activeProjectId).toBe(firstProject.id)
  })

  it('falls back to the active project when opened without a project', async () => {
    renderSettings([firstProject, secondProject], secondProject.id)
    act(() => useSettingsModalStore.getState().openProject())

    expect(await screen.findByLabelText('Name')).toHaveValue('Second Project')
    expect(useSettingsModalStore.getState().projectId).toBeNull()
  })
})

describe('ProjectSettings when the edited project disappears', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    apiMocks.getAvailableShells.mockResolvedValue({ success: true, data: null })
    apiMocks.parseGitignore.mockResolvedValue({ success: true, data: [] })
  })

  function removeSecondProject() {
    act(() =>
      useProjectStore.setState((state) => ({
        projects: state.projects.filter((p) => p.id !== secondProject.id)
      }))
    )
  }

  it('closes without saving when the project is deleted', async () => {
    const info = vi.spyOn(toast, 'info')
    const updateProject = vi.fn()
    renderSettings([firstProject, secondProject], firstProject.id, secondProject.id)
    useProjectStore.setState({ updateProject })
    expect(await screen.findByLabelText('Name')).toHaveValue('Second Project')

    removeSecondProject()

    expect(useSettingsModalStore.getState().view).toBeNull()
    expect(useSettingsModalStore.getState().projectId).toBeNull()
    expect(updateProject).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith('Project was removed, settings closed.')
  })

  it('drops pending edits so reopening shows no stale save bar', async () => {
    const info = vi.spyOn(toast, 'info')
    const updateProject = vi.fn()
    renderSettings([firstProject, secondProject], firstProject.id, secondProject.id)
    useProjectStore.setState({ updateProject })

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } })
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

    removeSecondProject()

    expect(useSettingsModalStore.getState().view).toBeNull()
    expect(updateProject).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)

    act(() => useSettingsModalStore.getState().openProject(undefined, firstProject.id))

    expect(await screen.findByLabelText('Name')).toHaveValue('First Project')
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument()
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('treats an archived project as gone', async () => {
    const info = vi.spyOn(toast, 'info')
    const updateProject = vi.fn()
    renderSettings([firstProject, secondProject], firstProject.id, secondProject.id)
    useProjectStore.setState({ updateProject })
    expect(await screen.findByLabelText('Name')).toHaveValue('Second Project')

    act(() =>
      useProjectStore.setState((state) => ({
        projects: state.projects.map((p) =>
          p.id === secondProject.id ? { ...p, isArchived: true } : p
        )
      }))
    )

    expect(useSettingsModalStore.getState().view).toBeNull()
    expect(updateProject).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('stays open when opened without a target and there is no active project', () => {
    const info = vi.spyOn(toast, 'info')
    renderSettings([], '', null)

    expect(useSettingsModalStore.getState().view).toBe('project')
    expect(info).not.toHaveBeenCalled()
  })
})
