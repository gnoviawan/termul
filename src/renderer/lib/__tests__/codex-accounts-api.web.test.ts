import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codexAccountsApi } from '@/lib/codex-accounts-api'

const transport = vi.hoisted(() => ({
  listCodexAccounts: vi.fn(),
  listCodexUsage: vi.fn(),
  setDefaultCodexAccount: vi.fn(),
  setProjectCodexAccount: vi.fn(),
  setCodexAutoSwitch: vi.fn(),
  addCodexAccount: vi.fn(),
  renameCodexAccount: vi.fn(),
  removeCodexAccount: vi.fn(),
  startCodexAccountLogin: vi.fn()
}))

vi.mock('@/lib/acp-transport', () => ({ getAcpTransport: () => transport }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/command-engine', () => ({
  runCommand: async ({ send }: { send: (call: { commandId: string }) => Promise<unknown> }) => ({
    result: await send({ commandId: 'cmd-1' })
  })
}))

const SNAPSHOT = {
  accounts: [{ id: 'default', name: 'Default', builtin: true, signedIn: true }],
  defaultAccountId: 'default',
  projectAccounts: {},
  autoSwitch: true
}

beforeEach(() => {
  vi.clearAllMocks()
  transport.listCodexAccounts.mockResolvedValue(SNAPSHOT)
  transport.setProjectCodexAccount.mockResolvedValue(true)
  transport.addCodexAccount.mockResolvedValue({ id: 'ab12', name: 'Work', createdAt: 1 })
  transport.removeCodexAccount.mockResolvedValue(['office'])
  transport.startCodexAccountLogin.mockResolvedValue({
    agentId: 'a1',
    capabilities: {},
    authMethods: []
  })
})

describe('codexAccountsApi', () => {
  it('lists, chooses, and stores the auto-switch flag over the transport', async () => {
    await expect(codexAccountsApi.list()).resolves.toEqual(SNAPSHOT)
    await codexAccountsApi.setDefault('ab12')
    await expect(
      codexAccountsApi.setProjectAccount('office', null, { expectedAccountId: 'ab12' })
    ).resolves.toBe(true)
    await codexAccountsApi.setAutoSwitch(false)
    expect(transport.setDefaultCodexAccount).toHaveBeenCalledWith('ab12')
    expect(transport.setProjectCodexAccount).toHaveBeenCalledWith('office', null, 'ab12')
    expect(transport.setCodexAutoSwitch).toHaveBeenCalledWith(false)
    transport.listCodexUsage.mockResolvedValue([])
    await codexAccountsApi.usage(true)
    expect(transport.listCodexUsage).toHaveBeenCalledWith(true)
  })

  it('adds, renames, removes, and starts a sign-in spawn', async () => {
    await expect(codexAccountsApi.add('Work')).resolves.toMatchObject({ id: 'ab12' })
    await codexAccountsApi.rename('ab12', 'Office')
    await expect(codexAccountsApi.remove('ab12')).resolves.toEqual(['office'])
    const config = { name: 'Codex', command: 'npx', args: [], env: {} }
    await expect(codexAccountsApi.startLogin('ab12', config)).resolves.toMatchObject({
      agentId: 'a1'
    })
    expect(transport.startCodexAccountLogin).toHaveBeenCalledWith('ab12', config, {
      commandId: 'cmd-1'
    })
  })
})
