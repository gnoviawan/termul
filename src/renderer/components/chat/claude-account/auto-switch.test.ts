import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountView,
  ClaudeRateLimit
} from '@shared/types/claude-accounts.types'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { decideAutoSwitch, startClaudeAutoSwitch } from './auto-switch'
import { useClaudeResumeStore, useClaudeSwitchingStore } from './use-claude-limit'
import type { AccountChoice } from './use-project-claude-account'

const { api, switcher } = vi.hoisted(() => ({
  api: { list: vi.fn(), usage: vi.fn() },
  switcher: { switchProjectClaudeAccount: vi.fn(), isChatOpenHere: vi.fn() }
}))

vi.mock('@/lib/claude-accounts-api', () => ({ claudeAccountsApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/stores/claude-account-switch', async () => {
  const actual = await vi.importActual<typeof import('@/stores/claude-account-switch')>(
    '@/stores/claude-account-switch'
  )
  return { ...actual, ...switcher }
})

const account = (id: string, name: string): ClaudeAccountView => ({
  id,
  name,
  builtin: id === 'default',
  signedIn: true
})

const choice = (id: string, name: string, percent: number): AccountChoice => ({
  account: account(id, name),
  usage: undefined,
  window: { kind: 'session', group: null, scope: null, percent, resetsAt: null, severity: null }
})

const limit = (resetsAt: number | null): ClaudeRateLimit => ({
  status: 'rejected',
  resetsAt,
  kind: 'five_hour',
  percent: 100,
  overageInUse: false
})

describe('decideAutoSwitch', () => {
  const work = choice('ab12', 'Work', 4)
  const side = choice('cd34', 'Side', 40)
  const base = { limit: limit(2_000), autoSwitch: true, limited: new Map(), now: 1_000_000 }

  it('does nothing when automatic switching is off', () => {
    expect(decideAutoSwitch({ ...base, autoSwitch: false, candidates: [work] })).toEqual({
      kind: 'none',
      reason: 'off'
    })
  })

  it('switches to the account with the most room', () => {
    expect(decideAutoSwitch({ ...base, candidates: [work, side] })).toEqual({
      kind: 'switch',
      to: work
    })
  })

  it('never moves back to an account that is still limited, but takes one that reset', () => {
    const limited = new Map<string, number | null>([['ab12', 2_000_000]])
    expect(decideAutoSwitch({ ...base, limited, candidates: [work, side] })).toEqual({
      kind: 'switch',
      to: side
    })
    const unknownReset = new Map<string, number | null>([['ab12', null]])
    expect(decideAutoSwitch({ ...base, limited: unknownReset, candidates: [work] })).toEqual({
      kind: 'resume',
      at: 2_000_000
    })
    const reset = new Map<string, number | null>([['ab12', 999_999]])
    expect(decideAutoSwitch({ ...base, limited: reset, candidates: [work] })).toEqual({
      kind: 'switch',
      to: work
    })
  })

  it('continues at the reset when no account has room', () => {
    expect(decideAutoSwitch({ ...base, candidates: [] })).toEqual({ kind: 'resume', at: 2_000_000 })
  })

  it('does nothing when no account has room and the reset time is unknown', () => {
    expect(decideAutoSwitch({ ...base, limit: limit(null), candidates: [] })).toEqual({
      kind: 'none',
      reason: 'no-room'
    })
  })
})

const read = (accountId: string, percent: number) => ({
  accountId,
  status: 'ok' as const,
  subscriptionType: 'max',
  windows: [{ kind: 'session', group: null, scope: null, percent, resetsAt: null, severity: null }],
  checkedAt: 1,
  message: null
})

const snapshot = (
  projectAccounts: Record<string, string> = {},
  autoSwitch = true
): ClaudeAccountsSnapshot => ({
  accounts: [account('default', 'Personal'), account('ab12', 'Work'), account('cd34', 'Side')],
  defaultAccountId: 'default',
  projectAccounts,
  autoSwitch
})

function setLimit(rateLimit: ClaudeRateLimit | null): void {
  useAcpStore.setState({
    sessionUsage: rateLimit
      ? { s1: { used: 1, size: 10, baselineUsed: 1, updatedAt: 1, source: 'reported', rateLimit } }
      : {}
  } as never)
}

function seed(): void {
  useAcpStore.setState({
    ...FRESH,
    sessions: {
      s1: {
        id: 's1',
        agentId: 'a1',
        cwd: '/work',
        projectId: 'office',
        status: 'active',
        title: null,
        activeTurn: false,
        openTurnId: null,
        modes: null,
        models: null,
        configOptions: [],
        lastError: null,
        createdAt: 1
      }
    },
    configToLiveAgent: { 'acp-registry:claude-acp\0/work': 'a1' },
    sessionUsage: {}
  } as never)
}

const logged = (): string[] =>
  vi.mocked(logFrontendError).mock.calls.map(([entry]) => (entry as { message: string }).message)

describe('startClaudeAutoSwitch', () => {
  let stop: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    seed()
    api.list.mockResolvedValue(snapshot())
    api.usage.mockResolvedValue([read('default', 100), read('ab12', 4), read('cd34', 40)])
    switcher.switchProjectClaudeAccount.mockResolvedValue(true)
    switcher.isChatOpenHere.mockReturnValue(true)
    stop = startClaudeAutoSwitch()
  })

  afterEach(() => {
    stop()
    useClaudeResumeStore.getState().cancel('s1')
  })

  it('switches the project of a chat at its limit and continues the chat', async () => {
    setLimit(limit(1_900_000_000))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledWith('office', 'ab12', {
      continueSessionIds: ['s1'],
      expectedAccountId: 'default'
    })
    expect(api.usage).toHaveBeenCalledWith(true)
    expect(toast.success).toHaveBeenCalledWith(
      'Personal reached its 5-hour limit. Continued on Work.'
    )
    expect(useClaudeSwitchingStore.getState()).toEqual({})
  })

  it('shows the switch on the card while it runs', async () => {
    let finish: (applied: boolean) => void = () => undefined
    switcher.switchProjectClaudeAccount.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    setLimit(limit(1_900_000_000))
    await vi.waitFor(() => expect(useClaudeSwitchingStore.getState()).toEqual({ s1: 'Work' }))
    finish(true)
    await vi.waitFor(() => expect(useClaudeSwitchingStore.getState()).toEqual({}))
  })

  it('acts once per limit, however often the same limit state arrives', async () => {
    setLimit(limit(1_900_000_000))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled())
    setLimit(limit(1_900_000_000))
    setLimit(limit(1_900_000_000))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledTimes(1)
  })

  it('moves on from a second limit without going back to the first account', async () => {
    setLimit(limit(1_900_000_000))
    await vi.waitFor(() => expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledTimes(1))
    // The restart clears the limit; the host's cached usage still shows room on Personal.
    setLimit(null)
    api.list.mockResolvedValue(snapshot({ office: 'ab12' }))
    api.usage.mockResolvedValue([read('default', 2), read('ab12', 100), read('cd34', 40)])
    setLimit(limit(1_900_000_000))
    await vi.waitFor(() => expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledTimes(2))
    expect(switcher.switchProjectClaudeAccount).toHaveBeenLastCalledWith('office', 'cd34', {
      continueSessionIds: ['s1'],
      expectedAccountId: 'ab12'
    })
  })

  it('does nothing else when another client switched the project first', async () => {
    switcher.switchProjectClaudeAccount.mockResolvedValue(false)
    setLimit(limit(1_900_000_000))
    await vi.waitFor(() =>
      expect(logged()).toContain(
        'Another client switched project office first; chats s1 continue there'
      )
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(useClaudeResumeStore.getState().at).toEqual({})
  })

  it('continues at the reset when no other account has room', async () => {
    api.usage.mockResolvedValue([read('default', 100), read('ab12', 100), read('cd34', 100)])
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    setLimit(limit(resetsAt))
    await vi.waitFor(() =>
      expect(useClaudeResumeStore.getState().at).toEqual({ s1: resetsAt * 1000 })
    )
    expect(switcher.switchProjectClaudeAccount).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'Personal reached its 5-hour limit. No other account has room.',
      expect.objectContaining({ description: expect.stringMatching(/^The chat continues at /) })
    )
  })

  it('leaves the chat alone when automatic switching is off', async () => {
    api.list.mockResolvedValue(snapshot({}, false))
    setLimit(limit(1_900_000_000))
    await vi.waitFor(() =>
      expect(logged()).toContain('Skipped chats s1: automatic switching is off')
    )
    expect(api.usage).not.toHaveBeenCalled()
    expect(switcher.switchProjectClaudeAccount).not.toHaveBeenCalled()
  })

  it('leaves a chat this client does not have open to the client that has it', async () => {
    switcher.isChatOpenHere.mockReturnValue(false)
    setLimit(limit(1_900_000_000))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(api.list).not.toHaveBeenCalled()
    switcher.isChatOpenHere.mockReturnValue(true)
    setLimit({ ...limit(1_900_000_000) })
    await vi.waitFor(() => expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledTimes(1))
  })
})
