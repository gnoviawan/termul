import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteFileExplorer } from './RemoteFileExplorer'

const mocks = vi.hoisted(() => ({
  sftpListDir: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  sshApi: {
    sftpListDir: mocks.sftpListDir,
    sftpDownload: vi.fn(),
    sftpDelete: vi.fn(),
    sftpMkdir: vi.fn()
  }
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('RemoteFileExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sftpListDir.mockResolvedValue({ success: true, data: [] })
  })

  it('loads the initial directory after mount', async () => {
    render(<RemoteFileExplorer connectionId="conn-1" initialPath="/srv" />)

    await waitFor(() => {
      expect(mocks.sftpListDir).toHaveBeenCalledWith('conn-1', '/srv')
    })
  })

  it('keeps long file names on the truncate path', async () => {
    const longName =
      'xxxxxxxxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxx_rev.docx'
    mocks.sftpListDir.mockResolvedValue({
      success: true,
      data: [
        {
          path: `/srv/${longName}`,
          name: longName,
          size: 1024,
          entryType: 'file',
          permissions: 0o644,
          modifiedAt: '2026-06-10T00:00:00.000Z'
        }
      ]
    })

    render(<RemoteFileExplorer connectionId="conn-1" initialPath="/srv" />)

    const nameEl = await screen.findByText(longName)
    expect(nameEl).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(nameEl.parentElement).toHaveClass('min-w-0', 'overflow-hidden')
  })
})
