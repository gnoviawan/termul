import { render, waitFor } from '@testing-library/react'
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
})
