import type { SFTPEntry } from '@shared/types/ssh.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSSHStore } from '@/stores/ssh-store'
import { SSHFileExplorer } from './SSHFileExplorer'

const { sshApi } = vi.hoisted(() => ({
  sshApi: {
    sftpRealpath: vi.fn(),
    sftpListDir: vi.fn(),
    sftpReadFile: vi.fn(),
    sftpMkdir: vi.fn(),
    sftpCreateFile: vi.fn(),
    sftpRename: vi.fn(),
    sftpDelete: vi.fn()
  }
}))
vi.mock('@/lib/api', () => ({ sshApi }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ok = <T,>(data: T) => ({ success: true as const, data })

const entries: SFTPEntry[] = [
  {
    name: 'logs',
    path: '/home/u/logs',
    entryType: 'directory',
    size: 0,
    permissions: 0o40755,
    modifiedAt: ''
  },
  {
    name: 'app.conf',
    path: '/home/u/app.conf',
    entryType: 'file',
    size: 2048,
    permissions: 0o100644,
    modifiedAt: ''
  }
]

async function renderExplorer() {
  render(<SSHFileExplorer connectionId="s1" profileName="Web" />)
  await screen.findByText('app.conf')
}

beforeEach(() => {
  vi.clearAllMocks()
  sshApi.sftpRealpath.mockResolvedValue(ok('/home/u'))
  sshApi.sftpListDir.mockResolvedValue(ok(entries))
  for (const op of ['sftpMkdir', 'sftpCreateFile', 'sftpRename', 'sftpDelete'] as const) {
    sshApi[op].mockResolvedValue(ok(undefined))
  }
  useSSHStore.setState({ editingFile: null, editingContent: '' })
})

describe('SSHFileExplorer', () => {
  it('lists the login directory with sizes and the current path', async () => {
    await renderExplorer()
    expect(screen.getByRole('region', { name: 'Files on Web' })).toBeInTheDocument()
    expect(screen.getByTitle('/home/u')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'logs' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a file in the editor, bound to the session', async () => {
    sshApi.sftpReadFile.mockResolvedValue(ok('listen 80;'))
    await renderExplorer()
    fireEvent.click(screen.getByTitle('Open app.conf'))
    await waitFor(() =>
      expect(useSSHStore.getState().editingFile).toMatchObject({
        connectionId: 's1',
        path: '/home/u/app.conf',
        content: 'listen 80;'
      })
    )
  })

  it('keeps the file opened last when an earlier read returns late', async () => {
    const other: SFTPEntry = { ...entries[1], name: 'b.conf', path: '/home/u/b.conf' }
    sshApi.sftpListDir.mockResolvedValue(ok([...entries, other]))
    let finishFirst: (value: unknown) => void = () => {}
    sshApi.sftpReadFile
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce(ok('second'))
    await renderExplorer()
    fireEvent.click(screen.getByTitle('Open app.conf'))
    fireEvent.click(screen.getByTitle('Open b.conf'))
    await waitFor(() => expect(useSSHStore.getState().editingFile?.path).toBe('/home/u/b.conf'))
    finishFirst(ok('first, late'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useSSHStore.getState().editingFile?.path).toBe('/home/u/b.conf')
    expect(useSSHStore.getState().editingContent).toBe('second')
  })

  it('does not apply a read when edits started while it was loading', async () => {
    let finishRead: (value: unknown) => void = () => {}
    sshApi.sftpReadFile.mockImplementationOnce(
      () => new Promise((resolve) => (finishRead = resolve))
    )
    await renderExplorer()
    fireEvent.click(screen.getByTitle('Open app.conf'))
    // While app.conf loads, the user edits the file already open.
    useSSHStore.setState({
      editingFile: {
        connectionId: 's1',
        path: '/home/u/notes.txt',
        name: 'notes.txt',
        content: 'a',
        originalContent: 'a'
      },
      editingContent: 'a, edited'
    })
    finishRead(ok('listen 80;'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(useSSHStore.getState().editingFile?.path).toBe('/home/u/notes.txt')
    expect(useSSHStore.getState().editingContent).toBe('a, edited')
  })

  it('does not replace a file that has unsaved edits', async () => {
    useSSHStore.setState({
      editingFile: {
        connectionId: 's1',
        path: '/home/u/notes.txt',
        name: 'notes.txt',
        content: 'a',
        originalContent: 'a'
      },
      editingContent: 'a, edited'
    })
    sshApi.sftpReadFile.mockResolvedValue(ok('listen 80;'))
    await renderExplorer()
    fireEvent.click(screen.getByTitle('Open app.conf'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(sshApi.sftpReadFile).not.toHaveBeenCalled()
    expect(useSSHStore.getState().editingFile?.path).toBe('/home/u/notes.txt')
    expect(useSSHStore.getState().editingContent).toBe('a, edited')
  })

  it('creates a folder through a named dialog and refreshes', async () => {
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const name = await screen.findByLabelText('Name')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('Enter a name.')).toBeInTheDocument()
    fireEvent.change(name, { target: { value: 'a/b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('A name cannot contain “/”.')).toBeInTheDocument()
    fireEvent.change(name, { target: { value: 'backups' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(sshApi.sftpMkdir).toHaveBeenCalledWith('s1', '/home/u/backups'))
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull())
    expect(sshApi.sftpListDir).toHaveBeenCalledTimes(2)
  })

  it('shows a server error inside the dialog', async () => {
    sshApi.sftpCreateFile.mockResolvedValue({
      success: false,
      error: "'x' already exists",
      code: 'E'
    })
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText("'x' already exists")).toBeInTheDocument()
  })

  it('renames in place', async () => {
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Rename app.conf' }))
    const name = await screen.findByLabelText('Name')
    expect(name).toHaveValue('app.conf')
    fireEvent.change(name, { target: { value: 'site.conf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() =>
      expect(sshApi.sftpRename).toHaveBeenCalledWith('s1', '/home/u/app.conf', '/home/u/site.conf')
    )
  })

  it('deletes only after confirmation', async () => {
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Delete app.conf' }))
    expect(screen.getByText("Delete “app.conf” on Web? This can't be undone.")).toBeInTheDocument()
    expect(sshApi.sftpDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(sshApi.sftpDelete).toHaveBeenCalledWith('s1', '/home/u/app.conf'))
  })

  it('goes up a folder and offers a retry when listing fails', async () => {
    await renderExplorer()
    sshApi.sftpListDir.mockResolvedValueOnce({
      success: false,
      error: 'Permission denied',
      code: 'E'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Up one folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
    expect(sshApi.sftpListDir).toHaveBeenLastCalledWith('s1', '/home')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('app.conf')
  })
})
