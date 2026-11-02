import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { AuthMethod } from '@/lib/acp-api'
import { agentReuseKey, useAcpStore } from '@/stores/acp-store'
import { useLoginTerminalSignInStore } from '@/stores/login-terminal-sign-in-store'
import { useAgentSignIn } from './use-agent-sign-in'

const mocks = vi.hoisted(() => ({
  onExit: vi.fn(),
  getExitCode: vi.fn(),
  spawnLogin: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/terminal-api', () => ({
  terminalApi: { onExit: mocks.onExit, getExitCode: mocks.getExitCode }
}))
vi.mock('./spawn-acp-login-terminal', () => ({ spawnAcpLoginTerminal: mocks.spawnLogin }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

const config: StoredAgentConfig = { id: 'devin', name: 'Devin', command: 'devin', args: ['acp'] }
const terminalLogin: AuthMethod = {
  id: 'devin-terminal-login',
  name: 'Terminal login',
  type: 'terminal',
  args: ['--login']
}

const initialAcp = useAcpStore.getState()
const authenticateAgent = vi.fn(() => Promise.resolve())
let exitListeners: Array<(id: string, code: number) => void> = []
const unlisten = vi.fn()

function emitExit(id: string, code: number): void {
  for (const listener of [...exitListeners]) listener(id, code)
}

function renderSignIn(onSignedIn: () => void) {
  return renderHook(() =>
    useAgentSignIn({
      registryAgentId: null,
      config,
      cwd: '/work',
      projectId: 'p1',
      projectEnvVars: undefined,
      paneId: 'pane1',
      onSignedIn
    })
  )
}

describe('useAgentSignIn terminal sign-in', () => {
  beforeEach(() => {
    useLoginTerminalSignInStore.setState({ byAgent: {} })
    exitListeners = []
    unlisten.mockReset()
    authenticateAgent.mockClear()
    mocks.toastError.mockReset()
    mocks.onExit.mockReset().mockImplementation((cb: (id: string, code: number) => void) => {
      exitListeners.push(cb)
      return () => {
        unlisten()
        exitListeners = exitListeners.filter((l) => l !== cb)
      }
    })
    mocks.getExitCode.mockReset().mockResolvedValue({ success: true, data: null })
    mocks.spawnLogin.mockReset().mockResolvedValue({ success: true, ptyId: 'pty-login' })
    useAcpStore.setState({
      configToLiveAgent: { [agentReuseKey('devin', '/work', 'p1')]: 'agent-live' },
      agents: {
        'agent-live': { id: 'agent-live', authMethods: [terminalLogin] }
      } as never,
      authenticateAgent
    } as never)
  })
  afterEach(() => {
    useAcpStore.setState(initialAcp, true)
  })

  it('authenticates and re-prepares on exit 0 while the caller is still mounted', async () => {
    const onSignedIn = vi.fn()
    const { result } = renderSignIn(onSignedIn)

    act(() => result.current.handleAuthMethod(terminalLogin))
    await waitFor(() => expect(mocks.getExitCode).toHaveBeenCalledWith('pty-login'))
    expect(result.current.signingInMethodId).toBe('devin-terminal-login')

    act(() => emitExit('pty-login', 0))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(authenticateAgent).toHaveBeenCalledWith('agent-live', 'devin-terminal-login')
    expect(result.current.signingInMethodId).toBeNull()
  })

  it('still authenticates and re-prepares after the surface that started it closed', async () => {
    // Issue #1648: the model selector popover or the phone setup sheet can
    // close while the login terminal is still open.
    const onSignedIn = vi.fn()
    const { result, unmount } = renderSignIn(onSignedIn)

    act(() => result.current.handleAuthMethod(terminalLogin))
    await waitFor(() => expect(mocks.getExitCode).toHaveBeenCalledWith('pty-login'))
    unmount()

    emitExit('pty-login', 0)
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(authenticateAgent).toHaveBeenCalledWith('agent-live', 'devin-terminal-login')
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('shows the sign-in as running when the surface opens again, and clears it on exit', async () => {
    const onSignedIn = vi.fn()
    const first = renderSignIn(onSignedIn)
    act(() => first.result.current.handleAuthMethod(terminalLogin))
    await waitFor(() => expect(mocks.getExitCode).toHaveBeenCalledWith('pty-login'))
    first.unmount()

    const second = renderSignIn(onSignedIn)
    expect(second.result.current.signingInMethodId).toBe('devin-terminal-login')
    // A second press must not open a second login terminal.
    act(() => second.result.current.handleAuthMethod(terminalLogin))
    expect(mocks.spawnLogin).toHaveBeenCalledTimes(1)

    act(() => emitExit('pty-login', 0))
    await waitFor(() => expect(second.result.current.signingInMethodId).toBeNull())
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  })

  it('toasts and does not authenticate when the closed surface’s login exits non-zero', async () => {
    const onSignedIn = vi.fn()
    const { result, unmount } = renderSignIn(onSignedIn)
    act(() => result.current.handleAuthMethod(terminalLogin))
    await waitFor(() => expect(mocks.getExitCode).toHaveBeenCalledWith('pty-login'))
    unmount()

    emitExit('pty-login', 2)
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Devin sign-in exited with code 2.')
    )
    expect(authenticateAgent).not.toHaveBeenCalled()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('ignores the exit of an unrelated terminal', async () => {
    const onSignedIn = vi.fn()
    const { result } = renderSignIn(onSignedIn)
    act(() => result.current.handleAuthMethod(terminalLogin))
    await waitFor(() => expect(mocks.getExitCode).toHaveBeenCalledWith('pty-login'))

    act(() => emitExit('pty-other', 0))
    expect(authenticateAgent).not.toHaveBeenCalled()
    expect(result.current.signingInMethodId).toBe('devin-terminal-login')
    act(() => emitExit('pty-login', 1))
  })

  it('handles an exit that landed before the listener saw it', async () => {
    mocks.getExitCode.mockResolvedValue({ success: true, data: 0 })
    const onSignedIn = vi.fn()
    const { result } = renderSignIn(onSignedIn)

    act(() => result.current.handleAuthMethod(terminalLogin))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(authenticateAgent).toHaveBeenCalledTimes(1)
    expect(result.current.signingInMethodId).toBeNull()
  })

  it('clears the sign-in and toasts when the login terminal cannot open', async () => {
    mocks.spawnLogin.mockResolvedValue({ success: false, error: 'pane closed' })
    const { result } = renderSignIn(vi.fn())

    act(() => result.current.handleAuthMethod(terminalLogin))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('pane closed'))
    expect(result.current.signingInMethodId).toBeNull()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
