import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn(), promise: vi.fn() }
}))

import { MAX_IMAGE_BYTES } from './chat-attachments'
import { useComposerAttachments } from './use-composer-attachments'

function fakeImage(size: number): File {
  return new File([new Uint8Array(size)], 'shot.png', { type: 'image/png' })
}

describe('useComposerAttachments size/type guards (spec-bug-report-dialog matrix row)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('toasts and skips an image over MAX_IMAGE_BYTES', async () => {
    const { result } = renderHook(() =>
      useComposerAttachments({ imageCapable: true, embedCapable: false, disabled: false })
    )
    await act(async () => {
      await result.current.addFiles([fakeImage(MAX_IMAGE_BYTES + 1)])
    })
    expect(toastError).toHaveBeenCalledWith('File too large')
    expect(result.current.attachments).toHaveLength(0)
  })

  it('toasts on an unsupported file type', async () => {
    const { result } = renderHook(() =>
      useComposerAttachments({ imageCapable: true, embedCapable: false, disabled: false })
    )
    await act(async () => {
      await result.current.addFiles([
        new File([new Uint8Array(8)], 'app.bin', { type: 'application/octet-stream' })
      ])
    })
    expect(toastError).toHaveBeenCalledWith('Unsupported file type (text or image only)')
    expect(result.current.attachments).toHaveLength(0)
  })

  it('stages an in-size image as a pending attachment', async () => {
    const { result } = renderHook(() =>
      useComposerAttachments({ imageCapable: true, embedCapable: false, disabled: false })
    )
    await act(async () => {
      await result.current.addFiles([fakeImage(64)])
    })
    expect(toastError).not.toHaveBeenCalled()
    expect(result.current.attachments).toHaveLength(1)
    expect(result.current.attachments[0].mimeType).toBe('image/png')
  })
})

describe('useComposerAttachments send reset', () => {
  it('keeps an attachment that finished reading while the send was in flight', async () => {
    const { result } = renderHook(() =>
      useComposerAttachments({ imageCapable: true, embedCapable: false, disabled: false })
    )
    await act(async () => {
      await result.current.addFiles([fakeImage(64)])
    })
    const sent = result.current.attachments
    await act(async () => {
      await result.current.addFiles([
        new File([new Uint8Array(32)], 'late.png', { type: 'image/png' })
      ])
    })

    act(() => result.current.clearAttachments(sent))
    expect(result.current.attachments.map((a) => a.name)).toEqual(['late.png'])

    act(() => result.current.clearAttachments())
    expect(result.current.attachments).toEqual([])
  })
})
