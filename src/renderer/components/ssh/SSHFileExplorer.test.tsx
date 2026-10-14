import type { SFTPEntry } from '@shared/types/ssh.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSSHStore } from '@/stores/ssh-store'
import { SSHFileExplorer } from './SSHFileExplorer'

const { sshApi, dialogApi, runtime, tempFiles } = vi.hoisted(() => ({
  runtime: { desktop: false },
  tempFiles: {
    writeBytesToTempFile: vi.fn(async (_bytes: Uint8Array, name: string) => `/tmp/x-${name}`),
    deleteTempFile: vi.fn(async () => {})
  },
  dialogApi: { selectFiles: vi.fn(), saveFile: vi.fn() },
  sshApi: {
    sftpRealpath: vi.fn(),
    sftpListDir: vi.fn(),
    sftpReadFile: vi.fn(),
    sftpMkdir: vi.fn(),
    sftpCreateFile: vi.fn(),
    sftpRename: vi.fn(),
    sftpDelete: vi.fn(),
    sftpUpload: vi.fn(),
    sftpDownload: vi.fn()
  }
}))
vi.mock('@/lib/api', () => ({ sshApi, dialogApi }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/composer-attachments-io', () => ({
  writeBytesToTempFile: tempFiles.writeBytesToTempFile
}))
vi.mock('@/lib/attachment-temp-cleanup', () => ({ deleteTempFile: tempFiles.deleteTempFile }))
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriContext: () => runtime.desktop
}))
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
  useSSHStore.setState({ editingFile: null, editingContent: '', transfers: [] })
  runtime.desktop = false
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

  it('opens a parent folder from the path', async () => {
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Go to /home' }))
    await waitFor(() => expect(sshApi.sftpListDir).toHaveBeenLastCalledWith('s1', '/home'))
    expect(screen.getByRole('button', { name: 'Go to root folder' })).toBeInTheDocument()
  })

  it('describes the focused entry in the details footer', async () => {
    await renderExplorer()
    expect(screen.queryByTestId('sftp-details')).toBeNull()
    fireEvent.focus(screen.getByTitle('Open app.conf'))
    const details = screen.getByTestId('sftp-details')
    expect(details).toHaveTextContent('app.conf')
    expect(details).toHaveTextContent('rw-r--r-- · 2.0 KB')
  })

  it('offers no upload or download outside the desktop app', async () => {
    await renderExplorer()
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download app.conf' })).toBeNull()
  })
})

describe('SSHFileExplorer transfers (desktop)', () => {
  beforeEach(() => {
    runtime.desktop = true
    sshApi.sftpUpload.mockResolvedValue(ok(undefined))
    sshApi.sftpDownload.mockResolvedValue(ok(undefined))
  })

  it('uploads picked files into the current folder and refreshes it', async () => {
    const local = String.raw`C:\Users\me\notes.txt`
    dialogApi.selectFiles.mockResolvedValue(ok([local]))
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() =>
      expect(sshApi.sftpUpload).toHaveBeenCalledWith('s1', local, '/home/u/notes.txt')
    )
    await waitFor(() => expect(sshApi.sftpListDir).toHaveBeenCalledTimes(2))
    expect(useSSHStore.getState().transfers).toEqual([
      expect.objectContaining({ remotePath: '/home/u/notes.txt', status: 'completed' })
    ])
    expect(screen.getByRole('region', { name: 'Transfers' })).toHaveTextContent('notes.txt')
  })

  it('asks before replacing a file that already exists', async () => {
    dialogApi.selectFiles.mockResolvedValue(ok(['/tmp/app.conf']))
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText('Replace 1 file?')).toBeInTheDocument()
    expect(
      screen.getByText(
        "“app.conf” already exists in /home/u on Web. Uploading replaces it. This can't be undone."
      )
    ).toBeInTheDocument()
    expect(sshApi.sftpUpload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() =>
      expect(sshApi.sftpUpload).toHaveBeenCalledWith('s1', '/tmp/app.conf', '/home/u/app.conf')
    )
  })

  it('does nothing when the file picker is dismissed', async () => {
    dialogApi.selectFiles.mockResolvedValue({ success: false, error: 'none', code: 'CANCELLED' })
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() => expect(dialogApi.selectFiles).toHaveBeenCalled())
    expect(sshApi.sftpUpload).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('downloads a file to the location picked in the save dialog', async () => {
    dialogApi.saveFile.mockResolvedValue(ok('/Users/me/app.conf'))
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Download app.conf' }))
    await waitFor(() =>
      expect(sshApi.sftpDownload).toHaveBeenCalledWith(
        's1',
        '/home/u/app.conf',
        '/Users/me/app.conf'
      )
    )
    expect(dialogApi.saveFile).toHaveBeenCalledWith({ title: 'Download', defaultPath: 'app.conf' })
    expect(screen.queryByRole('button', { name: 'Download logs' })).toBeNull()
  })

  it('shows a failed transfer with its reason', async () => {
    dialogApi.saveFile.mockResolvedValue(ok('/Users/me/app.conf'))
    sshApi.sftpDownload.mockResolvedValue({ success: false, error: 'Permission denied', code: 'E' })
    await renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Download app.conf' }))
    const row = await screen.findByTestId('sftp-transfer')
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'failed'))
    expect(row).toHaveTextContent('Permission denied')
  })
})

/** A file dragged in from the OS, readable unless `unreadable` (a dropped folder). */
function droppedFile(name: string, opts: { size?: number; unreadable?: boolean } = {}): File {
  const file = new File(['hi'], name)
  if (opts.size !== undefined) Object.defineProperty(file, 'size', { value: opts.size })
  Object.defineProperty(file, 'arrayBuffer', {
    value: opts.unreadable
      ? async () => {
          throw new DOMException('A requested file could not be read', 'NotFoundError')
        }
      : async () => new TextEncoder().encode('hi').buffer
  })
  return file
}

function osDrag(files: File[]) {
  return { dataTransfer: { types: ['Files'], files, items: [] } }
}

describe('SSHFileExplorer drag and drop (desktop)', () => {
  beforeEach(() => {
    runtime.desktop = true
    sshApi.sftpUpload.mockResolvedValue(ok(undefined))
  })

  it('shows the drop target and uploads a dropped file into the open folder', async () => {
    await renderExplorer()
    const zone = screen.getByTestId('sftp-drop-zone')
    const overlay = screen.getByTestId('sftp-drop-overlay')
    expect(overlay).not.toHaveAttribute('data-active')
    const file = droppedFile('notes.txt')
    fireEvent.dragEnter(zone, osDrag([file]))
    expect(overlay).toHaveAttribute('data-active', 'true')
    expect(overlay).toHaveTextContent('Drop to upload')
    expect(overlay).toHaveTextContent('/home/u')
    fireEvent.drop(zone, osDrag([file]))
    expect(overlay).not.toHaveAttribute('data-active')
    await waitFor(() =>
      expect(sshApi.sftpUpload).toHaveBeenCalledWith('s1', '/tmp/x-notes.txt', '/home/u/notes.txt')
    )
    await waitFor(() => expect(tempFiles.deleteTempFile).toHaveBeenCalledWith('/tmp/x-notes.txt'))
    await waitFor(() => expect(sshApi.sftpListDir).toHaveBeenCalledTimes(2))
  })

  it('uploads into the folder row the file is dropped on', async () => {
    await renderExplorer()
    const folderRow = screen.getByRole('button', { name: 'logs' })
    const file = droppedFile('notes.txt')
    fireEvent.dragEnter(folderRow, osDrag([file]))
    fireEvent.dragOver(folderRow, osDrag([file]))
    fireEvent.drop(folderRow, osDrag([file]))
    await waitFor(() => expect(sshApi.sftpUpload).toHaveBeenCalled())
    expect(sshApi.sftpUpload).toHaveBeenCalledWith(
      's1',
      '/tmp/x-notes.txt',
      '/home/u/logs/notes.txt'
    )
  })

  it('highlights the folder row under the drag and names it as the target', async () => {
    await renderExplorer()
    const folderRow = screen.getByRole('button', { name: 'logs' })
    fireEvent.dragEnter(folderRow, osDrag([droppedFile('notes.txt')]))
    fireEvent.dragOver(folderRow, osDrag([droppedFile('notes.txt')]))
    expect(folderRow.closest('[data-drop-target="true"]')).not.toBeNull()
    expect(screen.getByTitle('Open app.conf').closest('[data-drop-target="true"]')).toBeNull()
    const overlay = screen.getByTestId('sftp-drop-overlay')
    expect(overlay).toHaveAttribute('data-target', '/home/u/logs')
    expect(overlay).toHaveTextContent('Upload to /home/u/logs')
  })

  it('checks a collapsed folder for name clashes before uploading into it', async () => {
    await renderExplorer()
    // The default listing (also returned for /home/u/logs) holds app.conf.
    fireEvent.drop(screen.getByRole('button', { name: 'logs' }), osDrag([droppedFile('app.conf')]))
    await waitFor(() => expect(sshApi.sftpListDir).toHaveBeenCalledWith('s1', '/home/u/logs'))
    expect(await screen.findByText('Replace 1 file?')).toBeInTheDocument()
    expect(
      screen.getByText(
        "“app.conf” already exists in /home/u/logs on Web. Uploading replaces it. This can't be undone."
      )
    ).toBeInTheDocument()
    expect(sshApi.sftpUpload).not.toHaveBeenCalled()
  })

  it('reloads an expanded folder in place after uploading into it', async () => {
    const logEntry: SFTPEntry = {
      name: 'app.log',
      path: '/home/u/logs/app.log',
      entryType: 'file',
      size: 10,
      permissions: 0o100644,
      modifiedAt: ''
    }
    sshApi.sftpListDir.mockImplementation(async (_id: string, path: string) =>
      ok(path === '/home/u/logs' ? [logEntry] : entries)
    )
    await renderExplorer()
    const folderRow = screen.getByRole('button', { name: 'logs' })
    fireEvent.click(folderRow)
    await waitFor(() => expect(folderRow).toHaveAttribute('aria-expanded', 'true'))
    sshApi.sftpListDir.mockClear()
    fireEvent.drop(folderRow, osDrag([droppedFile('notes.txt')]))
    await waitFor(() =>
      expect(sshApi.sftpUpload).toHaveBeenCalledWith(
        's1',
        '/tmp/x-notes.txt',
        '/home/u/logs/notes.txt'
      )
    )
    await waitFor(() => expect(sshApi.sftpListDir).toHaveBeenCalledWith('s1', '/home/u/logs'))
    expect(sshApi.sftpListDir).not.toHaveBeenCalledWith('s1', '/home/u')
    expect(screen.getByRole('button', { name: 'logs' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('uploads into the open folder when dropped on a file row', async () => {
    await renderExplorer()
    fireEvent.drop(screen.getByTitle('Open app.conf'), osDrag([droppedFile('notes.txt')]))
    await waitFor(() =>
      expect(sshApi.sftpUpload).toHaveBeenCalledWith('s1', '/tmp/x-notes.txt', '/home/u/notes.txt')
    )
  })

  it('refuses a drop holding two different files with the same name', async () => {
    await renderExplorer()
    const first = droppedFile('report.csv')
    const second = droppedFile('report.csv', { size: 99 })
    fireEvent.drop(screen.getByTestId('sftp-drop-zone'), osDrag([first, second]))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Two of the files are named “report.csv”. Rename one, then upload them again.'
      )
    )
    expect(tempFiles.writeBytesToTempFile).not.toHaveBeenCalled()
    expect(sshApi.sftpUpload).not.toHaveBeenCalled()
  })

  it('asks before a dropped file replaces one in the folder', async () => {
    await renderExplorer()
    fireEvent.drop(screen.getByTestId('sftp-drop-zone'), osDrag([droppedFile('app.conf')]))
    expect(await screen.findByText('Replace 1 file?')).toBeInTheDocument()
    expect(sshApi.sftpUpload).not.toHaveBeenCalled()
  })

  it('refuses a dropped file that is too large to read into memory', async () => {
    await renderExplorer()
    const big = droppedFile('disk.img', { size: 600 * 1024 * 1024 })
    fireEvent.drop(screen.getByTestId('sftp-drop-zone'), osDrag([big]))
    const row = await screen.findByTestId('sftp-transfer')
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'failed'))
    expect(row).toHaveTextContent('Too large to drop. Use Upload instead.')
    expect(tempFiles.writeBytesToTempFile).not.toHaveBeenCalled()
    expect(sshApi.sftpUpload).not.toHaveBeenCalled()
  })

  it('marks a dropped folder as not uploadable', async () => {
    await renderExplorer()
    const folder = droppedFile('photos', { unreadable: true })
    fireEvent.drop(screen.getByTestId('sftp-drop-zone'), osDrag([folder]))
    const row = await screen.findByTestId('sftp-transfer')
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'failed'))
    expect(row).toHaveTextContent("Folders can't be uploaded. Drop the files inside it.")
    expect(sshApi.sftpUpload).not.toHaveBeenCalled()
  })

  it('ignores internal drags such as tabs', async () => {
    await renderExplorer()
    const zone = screen.getByTestId('sftp-drop-zone')
    const internal = { dataTransfer: { types: ['application/x-termul-tab'], files: [], items: [] } }
    fireEvent.dragEnter(zone, internal)
    expect(screen.getByTestId('sftp-drop-overlay')).not.toHaveAttribute('data-active')
    fireEvent.drop(zone, internal)
    expect(sshApi.sftpUpload).not.toHaveBeenCalled()
  })
})

describe('SSHFileExplorer drag and drop (web)', () => {
  it('does nothing outside the desktop app', async () => {
    await renderExplorer()
    const zone = screen.getByTestId('sftp-drop-zone')
    const file = droppedFile('notes.txt')
    fireEvent.dragEnter(zone, osDrag([file]))
    expect(screen.getByTestId('sftp-drop-overlay')).not.toHaveAttribute('data-active')
    fireEvent.drop(zone, osDrag([file]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tempFiles.writeBytesToTempFile).not.toHaveBeenCalled()
    expect(sshApi.sftpUpload).not.toHaveBeenCalled()
  })
})
