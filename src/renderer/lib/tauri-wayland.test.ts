import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, runtimeMock, logMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  runtimeMock: { isTauri: true },
  logMock: vi.fn(async (_payload: unknown) => {})
}))

vi.mock('./ipc/tauri', () => ({
  invokeIpcWrapped: (...args: unknown[]) => invokeMock(...args)
}))
vi.mock('./tauri-runtime', () => ({ isTauriContext: () => runtimeMock.isTauri }))
vi.mock('./log-api', () => ({ logFrontendError: (payload: unknown) => logMock(payload) }))

import { isWaylandSession } from './tauri-wayland'

describe('isWaylandSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMock.isTauri = true
  })

  it('invokes the is_wayland_session command and returns its boolean', async () => {
    invokeMock.mockResolvedValue({ success: true, data: true })
    await expect(isWaylandSession()).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('is_wayland_session')

    invokeMock.mockResolvedValue({ success: true, data: false })
    await expect(isWaylandSession()).resolves.toBe(false)
  })

  it('treats a failed detection as non-Wayland and logs a warning', async () => {
    invokeMock.mockResolvedValue({ success: false, error: 'boom', code: 'UNKNOWN_ERROR' })
    await expect(isWaylandSession()).resolves.toBe(false)
    expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })

  it('returns false without invoking outside the Tauri context', async () => {
    runtimeMock.isTauri = false
    await expect(isWaylandSession()).resolves.toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
