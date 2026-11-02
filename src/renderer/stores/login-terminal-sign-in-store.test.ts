import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import {
  beginLoginTerminalSignIn,
  useLoginTerminalSignInStore
} from './login-terminal-sign-in-store'

const mocks = vi.hoisted(() => ({
  onExit: vi.fn(),
  getExitCode: vi.fn(),
  toastError: vi.fn(),
  log: vi.fn((_entry: { level: string; source: string; message: string }) => Promise.resolve())
}))

vi.mock('@/lib/terminal-api', () => ({
  terminalApi: { onExit: mocks.onExit, getExitCode: mocks.getExitCode }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.log }))

const initialAcp = useAcpStore.getState()
const authenticateAgent = vi.fn((_agentId: string, _methodId: string) => Promise.resolve())
let exitListeners: Array<(id: string, code: number) => void> = []
const emitExit = (id: string, code: number): void => {
  for (const listener of [...exitListeners]) listener(id, code)
}
const begin = (onSignedIn = vi.fn()) =>
  beginLoginTerminalSignIn({
    agentId: 'agent-live',
    methodId: 'terminal-login',
    agentName: 'Devin',
    onSignedIn
  })

describe('beginLoginTerminalSignIn', () => {
  beforeEach(() => {
    useLoginTerminalSignInStore.setState({ byAgent: {} })
    exitListeners = []
    authenticateAgent.mockReset().mockResolvedValue(undefined)
    mocks.toastError.mockReset()
    mocks.log.mockClear()
    mocks.onExit.mockReset().mockImplementation((cb: (id: string, code: number) => void) => {
      exitListeners.push(cb)
      return () => {
        exitListeners = exitListeners.filter((l) => l !== cb)
      }
    })
    mocks.getExitCode.mockReset().mockResolvedValue({ success: true, data: null })
    useAcpStore.setState({ authenticateAgent } as never)
  })
  afterEach(() => {
    useAcpStore.setState(initialAcp, true)
  })

  it('records the sign-in by agent, then its pty, and refuses a second one', async () => {
    const watch = begin()
    expect(useLoginTerminalSignInStore.getState().byAgent['agent-live']).toEqual({
      agentId: 'agent-live',
      methodId: 'terminal-login',
      agentName: 'Devin',
      ptyId: null
    })
    expect(begin()).toBeNull()
    expect(mocks.onExit).toHaveBeenCalledTimes(1)

    await watch?.attach('pty-1')
    expect(useLoginTerminalSignInStore.getState().byAgent['agent-live']?.ptyId).toBe('pty-1')
  })

  it('ignores an exit seen before the pty is known', async () => {
    const onSignedIn = vi.fn()
    const watch = begin(onSignedIn)
    emitExit('pty-1', 0)
    expect(authenticateAgent).not.toHaveBeenCalled()

    await watch?.attach('pty-1')
    emitExit('pty-1', 0)
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(useLoginTerminalSignInStore.getState().byAgent).toEqual({})
    expect(exitListeners).toHaveLength(0)
  })

  it('re-prepares and toasts when authenticate fails after exit 0', async () => {
    authenticateAgent.mockRejectedValue(new Error('authenticate refused'))
    const onSignedIn = vi.fn()
    await begin(onSignedIn)?.attach('pty-1')

    emitExit('pty-1', 0)
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith('authenticate refused')
  })

  it('handles an exit once when the listener and the poll both see it', async () => {
    mocks.getExitCode.mockResolvedValue({ success: true, data: 0 })
    const onSignedIn = vi.fn()
    const watch = begin(onSignedIn)
    await watch?.attach('pty-1')
    emitExit('pty-1', 0)

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(authenticateAgent).toHaveBeenCalledTimes(1)
  })

  it('abandon forgets the sign-in without running it, so a new one can start', () => {
    const onSignedIn = vi.fn()
    begin(onSignedIn)?.abandon()

    expect(useLoginTerminalSignInStore.getState().byAgent).toEqual({})
    expect(exitListeners).toHaveLength(0)
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(begin()).not.toBeNull()
  })

  it('logs the boundary without the method env or any credentials', async () => {
    await begin()?.attach('pty-1')
    emitExit('pty-1', 3)

    const messages = mocks.log.mock.calls.map(([entry]) => entry.message)
    expect(messages).toEqual([
      "Opening a login terminal for agent-live with method 'terminal-login'",
      "Login terminal pty-1 for agent-live ('terminal-login') exited with code 3"
    ])
    expect(mocks.toastError).toHaveBeenCalledWith('Devin sign-in exited with code 3.')
  })
})
