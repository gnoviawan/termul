import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult } from '@shared/types/ipc.types'
import { useMediaObjectUrlState } from './use-media-object-url'

const { mockReadMediaBytes } = vi.hoisted(() => ({ mockReadMediaBytes: vi.fn() }))

vi.mock('@/lib/media-bytes-api', () => ({ readMediaBytes: mockReadMediaBytes }))

function deferred(): { promise: Promise<IpcResult<Blob>>; resolve: (r: IpcResult<Blob>) => void } {
  let resolve!: (r: IpcResult<Blob>) => void
  const promise = new Promise<IpcResult<Blob>>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('useMediaObjectUrlState', () => {
  const revoke = vi.fn()
  let nextUrl = 0

  beforeEach(() => {
    mockReadMediaBytes.mockReset()
    revoke.mockReset()
    nextUrl = 0
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => `blob:media-${++nextUrl}`,
      revokeObjectURL: revoke
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('re-reads on a revision bump and keeps the old URL until the new read settles', async () => {
    mockReadMediaBytes.mockResolvedValueOnce({ success: true, data: new Blob(['v1']) })
    const { result, rerender } = renderHook(
      ({ revision }) => useMediaObjectUrlState('/proj/chart.png', revision),
      { initialProps: { revision: 0 } }
    )
    await waitFor(() =>
      expect(result.current).toEqual({ status: 'ready', url: 'blob:media-1', size: 2 })
    )

    const second = deferred()
    mockReadMediaBytes.mockReturnValueOnce(second.promise)
    rerender({ revision: 1 })

    expect(mockReadMediaBytes).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual({ status: 'ready', url: 'blob:media-1', size: 2 })
    expect(revoke).not.toHaveBeenCalled()

    second.resolve({ success: true, data: new Blob(['v2!']) })
    await waitFor(() =>
      expect(result.current).toEqual({ status: 'ready', url: 'blob:media-2', size: 3 })
    )
    expect(revoke).toHaveBeenCalledWith('blob:media-1')
  })
})
