import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
const mockListen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen
}))

describe('tauri-terminal-api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('shares one Tauri listener across multiple onData subscribers and tears down after last unsubscribe', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}

    const unlisten = vi.fn()
    let eventHandler: ((event: { payload: { id: string; data: string } }) => void) | undefined

    mockListen.mockImplementation(
      async (_eventName: string, handler: (event: { payload: { id: string; data: string } }) => void) => {
        eventHandler = handler
        return unlisten
      }
    )

    const { createTauriTerminalApi } = await import('../tauri-terminal-api')
    const api = createTauriTerminalApi()

    const callbackA = vi.fn()
    const callbackB = vi.fn()

    const unsubscribeA = api.onData(callbackA)
    const unsubscribeB = api.onData(callbackB)

    await Promise.resolve()

    expect(mockListen).toHaveBeenCalledTimes(1)

    eventHandler?.({ payload: { id: 'pty-1', data: 'hello' } })

    expect(callbackA).toHaveBeenCalledWith('pty-1', new TextEncoder().encode('hello'))
    expect(callbackB).toHaveBeenCalledWith('pty-1', new TextEncoder().encode('hello'))

    unsubscribeA()
    expect(unlisten).not.toHaveBeenCalled()

    unsubscribeB()
    await Promise.resolve()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('registers new native listener after previous shared listener fully unsubscribed', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}

    const unlistenA = vi.fn()
    const unlistenB = vi.fn()

    mockListen
      .mockResolvedValueOnce(unlistenA)
      .mockResolvedValueOnce(unlistenB)

    const { createTauriTerminalApi } = await import('../tauri-terminal-api')
    const api = createTauriTerminalApi()

    const unsubscribeA = api.onExit(vi.fn())
    await Promise.resolve()
    expect(mockListen).toHaveBeenCalledTimes(1)

    unsubscribeA()
    await Promise.resolve()
    expect(unlistenA).toHaveBeenCalledTimes(1)

    const unsubscribeB = api.onExit(vi.fn())
    await Promise.resolve()
    expect(mockListen).toHaveBeenCalledTimes(2)

    unsubscribeB()
    await Promise.resolve()
    expect(unlistenB).toHaveBeenCalledTimes(1)
  })

  it('skips native listener registration outside Tauri context', async () => {
    const { createTauriTerminalApi } = await import('../tauri-terminal-api')
    const api = createTauriTerminalApi()

    const unsubscribe = api.onData(vi.fn())
    unsubscribe()

    expect(mockListen).not.toHaveBeenCalled()
  })
})
