import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openTerminalAtCwd: vi.fn(),
  write: vi.fn(),
  onData: vi.fn(),
  terminals: [] as Array<{ id: string; ptyId?: string }>
}))

vi.mock('@/lib/terminal-spawn', () => ({ openTerminalAtCwd: mocks.openTerminalAtCwd }))
vi.mock('@/lib/api', () => ({ terminalApi: { write: mocks.write, onData: mocks.onData } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: { getState: () => ({ terminals: mocks.terminals }) }
}))

import { openGithubSignInTerminal } from './github-sign-in'

let emitData: ((ptyId: string) => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  mocks.terminals = [{ id: 'term-1', ptyId: 'pty-1' }]
  mocks.openTerminalAtCwd.mockResolvedValue({ status: 'opened', terminalId: 'term-1' })
  mocks.write.mockResolvedValue({ success: true, data: undefined })
  mocks.onData.mockImplementation((callback: (id: string, data: Uint8Array) => void) => {
    emitData = (id) => callback(id, new Uint8Array([36]))
    return vi.fn()
  })
})

describe('openGithubSignInTerminal', () => {
  it('opens a terminal at the project cwd and types the login command once the shell prints', async () => {
    const pending = openGithubSignInTerminal('p1', '/repo', 'gh auth login --hostname ghe.acme.com')
    await vi.waitFor(() => expect(emitData).not.toBeNull())
    expect(mocks.write).not.toHaveBeenCalled()

    emitData?.('other-pty')
    emitData?.('pty-1')

    await expect(pending).resolves.toBe(true)
    expect(mocks.openTerminalAtCwd).toHaveBeenCalledWith('p1', '/repo', { name: 'GitHub sign-in' })
    expect(mocks.write).toHaveBeenCalledWith('pty-1', 'gh auth login --hostname ghe.acme.com\r')
  })

  it('refuses a command carrying control characters without opening a terminal', async () => {
    await expect(openGithubSignInTerminal('p1', '/repo', 'gh auth login\nrm -rf ~')).resolves.toBe(
      false
    )
    expect(mocks.openTerminalAtCwd).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('reports failure when the terminal cannot open', async () => {
    mocks.openTerminalAtCwd.mockResolvedValue({ status: 'no-pane' })
    await expect(openGithubSignInTerminal('p1', '/repo', 'gh auth login')).resolves.toBe(false)
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
