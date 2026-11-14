import type { CodexAccountUsage } from '@shared/types/codex-accounts.types'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { decideAutoSwitch, startCodexAutoSwitch } from './auto-switch'
import { useCodexResumeStore } from './use-codex-limit'
import type { CodexAccountChoice } from './use-project-codex-account'

const { api, switcher } = vi.hoisted(() => ({
  api: { list: vi.fn(), usage: vi.fn() },
  switcher: {
    switchProjectCodexAccount: vi.fn(),
    applyProjectCodexAccount: vi.fn(),
    isChatOpenHere: vi.fn(),
    restartCodexSession: vi.fn()
  }
}))

vi.mock('@/lib/codex-accounts-api', () => ({ codexAccountsApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/stores/codex-account-switch', async () => {
  const actual = await vi.importActual<typeof import('@/stores/codex-account-switch')>(
    '@/stores/codex-account-switch'
  )
  return {
    ...actual,
    switchProjectCodexAccount: switcher.switchProjectCodexAccount,
    applyProjectCodexAccount: switcher.applyProjectCodexAccount,
    isChatOpenHere: switcher.isChatOpenHere,
    restartCodexSession: switcher.restartCodexSession
  }
})

const account = (id: string, name: string) => ({
  id,
  name,
  builtin: id === 'default',
  signedIn: true
})

const choice = (id: string, name: string, percent: number): CodexAccountChoice => ({
  account: account(id, name),
  usage: undefined,
  window: { kind: 'session', percent, resetsAt: null, windowDurationMins: 300 }
})

const limit = (resetsAt: number | null) => ({
  status: 'rejected' as const,
  resetsAt,
  kind: 'five_hour',
  percent: 100,
  overageInUse: false
})

describe('decideAutoSwitch', () => {
  const work = choice('ab12', 'Work', 4)
  const base = { limit: limit(2_000), autoSwitch: true, limited: new Map(), now: 1_000_000 }

  it('does nothing when automatic switching is off', () => {
    expect(decideAutoSwitch({ ...base, autoSwitch: false, candidates: [work] })).toEqual({
      kind: 'none',
      reason: 'off'
    })
  })

  it('switches to the account with the most room', () => {
    expect(decideAutoSwitch({ ...base, candidates: [work] })).toEqual({ kind: 'switch', to: work })
  })

  it('continues at the reset when no account has room', () => {
    expect(decideAutoSwitch({ ...base, candidates: [] })).toEqual({ kind: 'resume', at: 2_000_000 })
  })
})

const read = (
  accountId: string,
  percent: number,
  resetsAt: string | null = null
): CodexAccountUsage => ({
  accountId,
  status: 'ok',
  planType: 'plus',
  windows: [{ kind: 'session', percent, resetsAt, windowDurationMins: 300 }],
  checkedAt: 1,
  message: null
})

const snapshot = (autoSwitch = true) => ({
  accounts: [account('default', 'Personal'), account('ab12', 'Work'), account('cd34', 'Side')],
  defaultAccountId: 'default',
  projectAccounts: {} as Record<string, string>,
  autoSwitch
})

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
    configToLiveAgent: { 'acp-registry:codex-acp\0/work\0project\0office': 'a1' },
    sessionUsage: {}
  } as never)
}

function setLimit(resetsAt: number | null): void {
  useAcpStore.setState({
    sessionUsage: {
      s1: {
        used: 1,
        size: 10,
        baselineUsed: 1,
        updatedAt: 1,
        source: 'reported',
        rateLimit: limit(resetsAt)
      }
    }
  } as never)
}

describe('startCodexAutoSwitch', () => {
  let stop: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    seed()
    api.list.mockResolvedValue(snapshot())
    api.usage.mockResolvedValue([read('default', 40), read('ab12', 4), read('cd34', 40)])
    switcher.switchProjectCodexAccount.mockResolvedValue(['s1'])
    switcher.applyProjectCodexAccount.mockResolvedValue(['s1'])
    switcher.isChatOpenHere.mockReturnValue(true)
    switcher.restartCodexSession.mockResolvedValue(true)
    stop = startCodexAutoSwitch()
  })

  afterEach(() => {
    stop()
    useCodexResumeStore.getState().cancel('s1')
  })

  it('switches with compare-and-set, resends the prompt, and cancels the held turn', async () => {
    setLimit(1_900_000_000)
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(switcher.switchProjectCodexAccount).toHaveBeenCalledWith('office', 'ab12', {
      continueSessionIds: ['s1'],
      expectedAccountId: 'default'
    })
    expect(toast.success).toHaveBeenCalledWith(
      'Personal reached its 5-hour limit. Continued on Work.'
    )
  })

  it('leaves the chat alone when automatic switching is off', async () => {
    api.list.mockResolvedValue(snapshot(false))
    setLimit(1_900_000_000)
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(logFrontendError)
          .mock.calls.map(([entry]) => (entry as { message: string }).message)
      ).toContain('Skipped chats s1: automatic switching is off')
    )
    expect(switcher.switchProjectCodexAccount).not.toHaveBeenCalled()
  })

  it('waits for the probe reset when no other account has room', async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
    api.usage.mockResolvedValue([
      read('default', 40, resetsAt),
      read('ab12', 100, resetsAt),
      read('cd34', 100, resetsAt)
    ])
    setLimit(null)
    const resetMs = Math.floor(Date.parse(resetsAt) / 1000) * 1000
    await vi.waitFor(() => expect(useCodexResumeStore.getState().at.s1).toBe(resetMs))
    expect(switcher.switchProjectCodexAccount).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'Personal reached its 5-hour limit. No other account has room.',
      expect.objectContaining({ description: expect.stringMatching(/^The chat continues at /) })
    )
  })

  it('treats a mid-turn rate_limited error as at-limit and switches', async () => {
    useAcpStore.getState()._onAgentError({
      agentId: 'a1',
      sessionId: 's1',
      message: 'usage limit',
      code: -32603,
      data: { errorKind: 'rate_limited' }
    })
    await vi.waitFor(() => expect(switcher.switchProjectCodexAccount).toHaveBeenCalled())
    expect(switcher.switchProjectCodexAccount).toHaveBeenCalledWith('office', 'ab12', {
      continueSessionIds: ['s1'],
      expectedAccountId: 'default'
    })
  })

  it('restarts limited chats when another client switched the project first', async () => {
    switcher.switchProjectCodexAccount.mockResolvedValue(null)
    setLimit(1_900_000_000)
    await vi.waitFor(() => expect(switcher.applyProjectCodexAccount).toHaveBeenCalled())
    expect(switcher.applyProjectCodexAccount).toHaveBeenCalledWith('office', {
      continueSessionIds: ['s1']
    })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('does not resend a completed chat when the probe is at 100%', async () => {
    api.usage.mockResolvedValue([read('default', 100), read('ab12', 4), read('cd34', 40)])
    stop()
    stop = startCodexAutoSwitch()
    await vi.waitFor(() => expect(api.usage).toHaveBeenCalled())
    expect(switcher.switchProjectCodexAccount).not.toHaveBeenCalled()
  })

  it('switches a held turn when the probe is at 100% and the window is still open', async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
    api.usage.mockResolvedValue([
      read('default', 100, resetsAt),
      read('ab12', 4, resetsAt),
      read('cd34', 40, resetsAt)
    ])
    useAcpStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        s1: { ...state.sessions.s1, activeTurn: true }
      }
    }))
    stop()
    stop = startCodexAutoSwitch()
    await vi.waitFor(() => expect(switcher.switchProjectCodexAccount).toHaveBeenCalled())
  })

  it('treats a mid-turn quota_exhausted error as at-limit and switches', async () => {
    useAcpStore.getState()._onAgentError({
      agentId: 'a1',
      sessionId: 's1',
      message: 'quota',
      code: -32603,
      data: { errorKind: 'quota_exhausted' }
    })
    await vi.waitFor(() =>
      expect(switcher.switchProjectCodexAccount).toHaveBeenCalledWith('office', 'ab12', {
        continueSessionIds: ['s1'],
        expectedAccountId: 'default'
      })
    )
  })
})
