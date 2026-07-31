import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SSHFileExplorer } from './SSHFileExplorer'

vi.mock('@/stores/ssh-store', () => ({
  useSSHActions: () => ({
    setEditingFile: vi.fn(),
    setEditingContent: vi.fn()
  })
}))

vi.mock('@/lib/api', () => ({
  sshApi: {
    sftpReadFile: vi.fn()
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

describe('SSHFileExplorer', () => {
  it('keeps long file names on the truncate path', () => {
    const longName =
      'xxxxxxxxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxx_rev.docx'

    render(
      <SSHFileExplorer
        connectionId="conn-1"
        isConnected={true}
        sftpReady={true}
        entries={[
          {
            path: `/srv/${longName}`,
            name: longName,
            size: 1024,
            entryType: 'file',
            permissions: 0o644,
            modifiedAt: '2026-06-10T00:00:00.000Z'
          }
        ]}
        currentPath="/srv"
        expandedDirs={new Set()}
        childEntries={new Map()}
        loadingDirs={new Set()}
        isLoadingRoot={false}
        profileName="server"
        onConnect={vi.fn()}
        onBrowseFiles={vi.fn()}
        onToggleDir={vi.fn()}
        onLoadDir={vi.fn()}
        onMkdir={vi.fn()}
        onCreateFile={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />
    )

    const nameEl = screen.getByText(longName)
    expect(nameEl).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(nameEl.parentElement).toHaveClass('min-w-0', 'overflow-hidden')
  })
})
