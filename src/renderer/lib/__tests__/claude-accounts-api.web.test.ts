/**
 * Claude Accounts facade on both surfaces: list/default/project go through the
 * ACP transport everywhere; add/login/rename/remove invoke Tauri on desktop
 * and reject with `ClaudeAccountsUnsupportedError` on web without a request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockInvoke, transport } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn(),
  transport: {
    listClaudeAccounts: vi.fn(),
    listClaudeUsage: vi.fn(),
    setDefaultClaudeAccount: vi.fn(),
    setProjectClaudeAccount: vi.fn()
  }
}))

vi.mock('../tauri-runtime', () => ({ isTauriContext: mockIsTauriContext }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('../acp-transport', () => ({ getAcpTransport: () => transport }))
vi.mock('../log-api', () => ({ logFrontendError: vi.fn() }))

import { ClaudeAccountsUnsupportedError, claudeAccountsApi } from '../claude-accounts-api'

const SNAPSHOT = {
  accounts: [{ id: 'default', name: 'Default', builtin: true, signedIn: true }],
  defaultAccountId: 'default',
  projectAccounts: {}
}

beforeEach(() => {
  vi.clearAllMocks()
  transport.listClaudeAccounts.mockResolvedValue(SNAPSHOT)
  transport.listClaudeUsage.mockResolvedValue([])
  transport.setDefaultClaudeAccount.mockResolvedValue(undefined)
  transport.setProjectClaudeAccount.mockResolvedValue(undefined)
})

describe.each([
  ['desktop', true],
  ['web', false]
])('claudeAccountsApi view and choose on %s', (_surface, tauri) => {
  beforeEach(() => mockIsTauriContext.mockReturnValue(tauri))

  it('lists through the ACP transport', async () => {
    await expect(claudeAccountsApi.list()).resolves.toEqual(SNAPSHOT)
    expect(transport.listClaudeAccounts).toHaveBeenCalledOnce()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('reads usage through the ACP transport, forced or not', async () => {
    await claudeAccountsApi.usage()
    await claudeAccountsApi.usage(true)
    expect(transport.listClaudeUsage.mock.calls).toEqual([[false], [true]])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('sets the default and a project account through the ACP transport', async () => {
    await claudeAccountsApi.setDefault('abc')
    await claudeAccountsApi.setProjectAccount('p1', null)
    expect(transport.setDefaultClaudeAccount).toHaveBeenCalledWith('abc')
    expect(transport.setProjectClaudeAccount).toHaveBeenCalledWith('p1', null)
  })
})

describe('claudeAccountsApi management on desktop', () => {
  beforeEach(() => mockIsTauriContext.mockReturnValue(true))

  it('invokes the desktop commands', async () => {
    mockInvoke.mockResolvedValueOnce({ id: 'abc', name: 'Work', createdAt: 1 })
    await expect(claudeAccountsApi.add('Work')).resolves.toMatchObject({ id: 'abc' })
    mockInvoke.mockResolvedValue(undefined)
    await claudeAccountsApi.login('abc')
    await claudeAccountsApi.cancelLogin('abc')
    await claudeAccountsApi.rename('abc', 'Office')
    mockInvoke.mockResolvedValueOnce(['p1'])
    await expect(claudeAccountsApi.remove('abc')).resolves.toEqual(['p1'])
    expect(mockInvoke.mock.calls).toEqual([
      ['claude_accounts_add', { name: 'Work' }],
      ['claude_accounts_login', { accountId: 'abc' }],
      ['claude_accounts_login_cancel', { accountId: 'abc' }],
      ['claude_accounts_rename', { accountId: 'abc', name: 'Office' }],
      ['claude_accounts_remove', { accountId: 'abc' }]
    ])
    expect(claudeAccountsApi.canManageAccounts()).toBe(true)
  })

  it('passes a host error through', async () => {
    mockInvoke.mockRejectedValueOnce('An account named "Work" already exists')
    await expect(claudeAccountsApi.add('Work')).rejects.toBe(
      'An account named "Work" already exists'
    )
  })
})

describe('claudeAccountsApi management on web', () => {
  beforeEach(() => mockIsTauriContext.mockReturnValue(false))

  it('rejects add, login, rename and remove without a request', async () => {
    for (const call of [
      () => claudeAccountsApi.add('Work'),
      () => claudeAccountsApi.login('abc'),
      () => claudeAccountsApi.cancelLogin('abc'),
      () => claudeAccountsApi.rename('abc', 'Office'),
      () => claudeAccountsApi.remove('abc')
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ClaudeAccountsUnsupportedError)
    }
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(claudeAccountsApi.canManageAccounts()).toBe(false)
  })
})
