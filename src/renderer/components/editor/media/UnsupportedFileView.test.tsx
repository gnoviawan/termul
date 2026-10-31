import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { copyTextMock, toastMock } = vi.hoisted(() => ({
  copyTextMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() }
}))

vi.mock('@/lib/copy-text', () => ({ copyText: copyTextMock }))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/lib/api', () => ({ openerApi: { revealInFileManager: vi.fn() } }))

import { previewUnavailableFromRead, UnsupportedFileView } from './UnsupportedFileView'

describe('UnsupportedFileView', () => {
  beforeEach(() => {
    copyTextMock.mockReset()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
  })

  it('reads a path that became a directory as unreadable, not missing', () => {
    expect(
      previewUnavailableFromRead({ code: 'NOT_A_FILE', message: 'path is not a regular file' })
    ).toEqual({ reason: 'unreadable', message: 'path is not a regular file' })
    expect(previewUnavailableFromRead({ code: 'NOT_FOUND', message: 'file not found' })).toEqual({
      reason: 'missing'
    })
  })

  it('reports a failed copy instead of claiming the path was copied', async () => {
    copyTextMock.mockResolvedValue(false)
    render(<UnsupportedFileView filePath="/p/app.exe" unavailable={{ reason: 'binary' }} />)

    fireEvent.click(screen.getByRole('button', { name: /copy path/i }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Couldn't copy the path"))
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('confirms a copied path', async () => {
    copyTextMock.mockResolvedValue(true)
    render(<UnsupportedFileView filePath="/p/app.exe" unavailable={{ reason: 'binary' }} />)

    fireEvent.click(screen.getByRole('button', { name: /copy path/i }))

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Path copied', { description: '/p/app.exe' })
    )
  })
})
