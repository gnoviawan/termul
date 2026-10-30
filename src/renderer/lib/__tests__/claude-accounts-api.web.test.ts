/**
 * Claude Accounts facade on both surfaces: list/default/project, add, rename,
 * remove, the link sign-in and cancel go through the ACP transport everywhere;
 * the browser login invokes Tauri on desktop and rejects with
 * `ClaudeAccountsUnsupportedError` on web without a request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockInvoke, transport } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn(),
  transport: {
    listClaudeAccounts: vi.fn(),
    listClaudeUsage: vi.fn(),
    setDefaultClaudeAccount: vi.fn(),
    setProjectClaudeAccount: vi.fn(),
    setClaudeAutoSwitch: vi.fn(),
    addClaudeAccount: vi.fn(),
    renameClaudeAccount: vi.fn(),
    removeClaudeAccount: vi.fn(),
    startClaudeLinkLogin: vi.fn(),
    finishClaudeLinkLogin: vi.fn(),
    cancelClaudeLogin: vi.fn()
  }
}))

vi.mock('../tauri-runtime', () => ({ isTauriContext: mockIsTauriContext }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('../acp-transport', () => ({ getAcpTransport: () => transport }))
vi.mock('../log-api', () => ({ logFrontendError: vi.fn() }))

import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { AcpTransportError } from '../acp-transport/types'
import {
  ClaudeAccountsUnsupportedError,
  claudeAccountsApi,
  isClaudeLoginCodeIncomplete
} from '../claude-accounts-api'

const SNAPSHOT = {
  accounts: [{ id: 'default', name: 'Default', builtin: true, signedIn: true }],
  defaultAccountId: 'default',
  projectAccounts: {},
  autoSwitch: true
}

beforeEach(() => {
  vi.clearAllMocks()
  transport.listClaudeAccounts.mockResolvedValue(SNAPSHOT)
  transport.listClaudeUsage.mockResolvedValue([])
  transport.setDefaultClaudeAccount.mockResolvedValue(undefined)
  transport.setProjectClaudeAccount.mockResolvedValue(true)
  transport.setClaudeAutoSwitch.mockResolvedValue(undefined)
  transport.addClaudeAccount.mockResolvedValue({ id: 'abc', name: 'Work', createdAt: 1 })
  transport.renameClaudeAccount.mockResolvedValue(undefined)
  transport.removeClaudeAccount.mockResolvedValue(['p1'])
  transport.startClaudeLinkLogin.mockResolvedValue('https://claude.com/cai/oauth/authorize')
  transport.finishClaudeLinkLogin.mockResolvedValue(undefined)
  transport.cancelClaudeLogin.mockResolvedValue(true)
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
    expect(transport.setProjectClaudeAccount).toHaveBeenCalledWith('p1', null, undefined)
  })

  it('passes the expected account and reports a lost compare-and-set', async () => {
    transport.setProjectClaudeAccount.mockResolvedValueOnce(false)
    await expect(
      claudeAccountsApi.setProjectAccount('p1', 'ab12', { expectedAccountId: 'default' })
    ).resolves.toBe(false)
    expect(transport.setProjectClaudeAccount).toHaveBeenCalledWith('p1', 'ab12', 'default')
  })

  it('adds an account through the ACP transport with a command id', async () => {
    await expect(claudeAccountsApi.add('Work')).resolves.toMatchObject({ id: 'abc' })
    const [name, call] = transport.addClaudeAccount.mock.calls[0]
    expect(name).toBe('Work')
    expect(call.commandId).toEqual(expect.any(String))
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('runs the link sign-in and its cancel through the ACP transport', async () => {
    await expect(claudeAccountsApi.startLinkLogin('abc')).resolves.toBe(
      'https://claude.com/cai/oauth/authorize'
    )
    await claudeAccountsApi.finishLinkLogin('abc', 'code#state')
    await expect(claudeAccountsApi.cancelLogin('abc')).resolves.toBe(true)
    expect(transport.startClaudeLinkLogin).toHaveBeenCalledWith('abc')
    const [account, code, call] = transport.finishClaudeLinkLogin.mock.calls[0]
    expect([account, code]).toEqual(['abc', 'code#state'])
    expect(call.commandId).toEqual(expect.any(String))
    expect(transport.cancelClaudeLogin).toHaveBeenCalledWith('abc')
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('passes an incomplete code through as a rejection the caller can recognize', async () => {
    const incomplete = new AcpTransportError(
      WS_ERROR_CODES.CLAUDE_LOGIN_CODE_INCOMPLETE,
      'That code is incomplete.'
    )
    transport.finishClaudeLinkLogin.mockRejectedValueOnce(incomplete)
    const error = await claudeAccountsApi.finishLinkLogin('abc', 'abc').catch((e: unknown) => e)
    expect(error).toBe(incomplete)
    expect(isClaudeLoginCodeIncomplete(error)).toBe(true)
    expect(isClaudeLoginCodeIncomplete(new Error('That code is incomplete.'))).toBe(false)
  })

  it('renames and removes an account through the ACP transport', async () => {
    await claudeAccountsApi.rename('abc', 'Office')
    await expect(claudeAccountsApi.remove('abc')).resolves.toEqual(['p1'])
    expect(transport.renameClaudeAccount).toHaveBeenCalledWith('abc', 'Office')
    expect(transport.removeClaudeAccount).toHaveBeenCalledWith('abc')
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('passes a host error through', async () => {
    transport.renameClaudeAccount.mockRejectedValueOnce(
      new Error('That Claude account does not exist')
    )
    await expect(claudeAccountsApi.rename('abc', 'Office')).rejects.toThrow(
      'That Claude account does not exist'
    )
  })

  it('turns automatic switching on and off through the ACP transport', async () => {
    await claudeAccountsApi.setAutoSwitch(false)
    expect(transport.setClaudeAutoSwitch).toHaveBeenCalledWith(false)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

describe('claudeAccountsApi on desktop', () => {
  beforeEach(() => mockIsTauriContext.mockReturnValue(true))

  it('signs in through the host browser', async () => {
    mockInvoke.mockResolvedValue(undefined)
    await claudeAccountsApi.login('abc')
    expect(mockInvoke.mock.calls).toEqual([['claude_accounts_login', { accountId: 'abc' }]])
    expect(claudeAccountsApi.signInFlow()).toBe('browser')
  })
})

describe('claudeAccountsApi on web', () => {
  beforeEach(() => mockIsTauriContext.mockReturnValue(false))

  it('signs in with a link and rejects the browser login without a request', async () => {
    await expect(claudeAccountsApi.login('abc')).rejects.toBeInstanceOf(
      ClaudeAccountsUnsupportedError
    )
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(claudeAccountsApi.signInFlow()).toBe('link')
  })
})
