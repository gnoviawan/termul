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

  it('handles an exit seen before attach names its pty, and ignores other ptys', async () => {
    // getExitCode records no marker for a directly spawned login process.
    const onSignedIn = vi.fn()
    const watch = begin(onSignedIn)
    emitExit('pty-other', 0)
    emitExit('pty-1', 0)
    expect(authenticateAgent).not.toHaveBeenCalled()

    await watch?.attach('pty-1')
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(authenticateAgent).toHaveBeenCalledTimes(1)
    expect(mocks.getExitCode).not.toHaveBeenCalled()
    expect(useLoginTerminalSignInStore.getState().byAgent).toEqual({})
    expect(exitListeners).toHaveLength(0)
  })

  it('clears the sign-in on a non-zero exit before attach', async () => {
    const watch = begin()
    emitExit('pty-1', 1)
    await watch?.attach('pty-1')

    expect(useLoginTerminalSignInStore.getState().byAgent).toEqual({})
    expect(mocks.toastError).toHaveBeenCalledWith('Devin sign-in exited with code 1.')
    expect(begin()).not.toBeNull()
  })

  it('ignores exits of other ptys after attach', async () => {
    const onSignedIn = vi.fn()
    const watch = begin(onSignedIn)
    await watch?.attach('pty-1')
    emitExit('pty-other', 0)
    expect(authenticateAgent).not.toHaveBeenCalled()

    emitExit('pty-1', 0)
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(useLoginTerminalSignInStore.getState().byAgent).toEqual({})
    expect(exitListeners).toHaveLength(0)
  })

  it('re-prepares and toasts when authenticate fails after exit 0, without logging the error', async () => {
    authenticateAgent.mockRejectedValue(new Error('authenticate refused: token sk-secret'))
    const onSignedIn = vi.fn()
    await begin(onSignedIn)?.attach('pty-1')

    emitExit('pty-1', 0)
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith('authenticate refused: token sk-secret')
    const messages = mocks.log.mock.calls.map(([entry]) => entry.message)
    expect(messages).toContain('authenticate after the login terminal failed for agent-live')
    expect(messages.join('\n')).not.toContain('sk-secret')
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
