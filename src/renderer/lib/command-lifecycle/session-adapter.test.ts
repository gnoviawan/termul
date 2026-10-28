import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import { afterEach, expect, it, vi } from 'vitest'
import { mockTerminal } from '@/lib/test-utils/terminal'
import { useTerminalStore } from '@/stores/terminal-store'
import { disposeSessionAdapter, forwardSessionLifecycle } from './session-adapter'
import { sessionStore } from './session-store'

const event = (
  kind: SessionLifecyclePayload['kind'],
  terminal_id = 'pty'
): SessionLifecyclePayload => ({
  type: 'session_lifecycle',
  kind,
  terminal_id,
  session_id: 's',
  nonce: 'n',
  prompt_generation: 1,
  cwd: '/repo',
  line_empty: true,
  prompt_suppressed: true,
  exit_code: null
})

afterEach(() => {
  vi.useRealTimers()
  sessionStore.reset()
  useTerminalStore.getState().setTerminals([])
})

it('forwards events before bind through the real adapter', async () => {
  forwardSessionLifecycle(event('InitShell'))
  forwardSessionLifecycle(event('PromptReady'))
  await import('@/stores/terminal-store')
  await Promise.resolve()
  expect(useTerminalStore.getState().findTerminalByPtyId('pty')).toBeUndefined()
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  await vi.waitFor(() =>
    expect(sessionStore.read('t')).toMatchObject({
      registered: true,
      trusted: true,
      mode: 'Editor'
    })
  )
})

it('disposal releases the terminal-store subscription so a reload subscribes once', async () => {
  disposeSessionAdapter()
  const subscribe = useTerminalStore.subscribe
  const released = vi.fn()
  const spy = vi.spyOn(useTerminalStore, 'subscribe').mockImplementation((listener) => {
    const unsubscribe = subscribe(listener)
    return () => {
      released()
      unsubscribe()
    }
  })
  try {
    forwardSessionLifecycle(event('InitShell', 'pty-a'))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    disposeSessionAdapter()
    expect(released).toHaveBeenCalledTimes(1)
    forwardSessionLifecycle(event('InitShell', 'pty-a'))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'ta', ptyId: 'pty-a' })])
    expect(sessionStore.read('ta').registered).toBe(true)
  } finally {
    disposeSessionAdapter()
    spy.mockRestore()
  }
})
