import type { ClaudeRateLimit } from '@shared/types/claude-accounts.types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { ClaudeAccountChip } from './ClaudeAccountChip'
import { ClaudeLimitNotice, useClaudeResumeStore } from './ClaudeLimitNotice'

const { api, switcher } = vi.hoisted(() => ({
  api: { list: vi.fn(), usage: vi.fn(), canManageAccounts: vi.fn(() => true) },
  switcher: { switchProjectClaudeAccount: vi.fn(), restartClaudeSession: vi.fn() }
}))

vi.mock('@/lib/claude-accounts-api', () => ({ claudeAccountsApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/stores/claude-account-switch', async () => {
  const actual = await vi.importActual<typeof import('@/stores/claude-account-switch')>(
    '@/stores/claude-account-switch'
  )
  return { ...actual, ...switcher }
})

const read = (accountId: string, percent: number) => ({
  accountId,
  status: 'ok' as const,
  subscriptionType: 'max',
  windows: [{ kind: 'session', group: null, scope: null, percent, resetsAt: null, severity: null }],
  checkedAt: Date.now(),
  message: null
})

function seed(rateLimit?: ClaudeRateLimit): void {
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
    sessionUsage: rateLimit
      ? { s1: { used: 1, size: 10, baselineUsed: 1, updatedAt: 1, source: 'reported', rateLimit } }
      : {}
  } as never)
}

const limit = (
  status: string,
  percent: number,
  resetsAt: number | null = null
): ClaudeRateLimit => ({
  status,
  resetsAt,
  kind: 'five_hour',
  percent,
  overageInUse: false
})

beforeEach(() => {
  vi.clearAllMocks()
  api.canManageAccounts.mockReturnValue(true)
  api.list.mockResolvedValue({
    accounts: [
      { id: 'default', name: 'Personal', builtin: true, signedIn: true },
      { id: 'ab12', name: 'Work', builtin: false, signedIn: true },
      { id: 'cd34', name: 'Side', builtin: false, signedIn: true }
    ],
    defaultAccountId: 'default',
    projectAccounts: {}
  })
  api.usage.mockResolvedValue([read('default', 100), read('ab12', 4), read('cd34', 40)])
  switcher.switchProjectClaudeAccount.mockResolvedValue(undefined)
  switcher.restartClaudeSession.mockResolvedValue(true)
})

afterEach(() => {
  useClaudeResumeStore.getState().cancel('s1')
  vi.useRealTimers()
})

describe('ClaudeLimitNotice', () => {
  it('shows nothing without a live limit state', () => {
    seed()
    const { container } = render(<ClaudeLimitNotice sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('warns calmly near the limit and offers the account with the most room', async () => {
    seed(limit('allowed_warning', 84))
    render(<ClaudeLimitNotice sessionId="s1" />)
    expect(await screen.findByText(/Personal has used 84% of its 5-hour limit/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Work' }))
    await waitFor(() =>
      expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledWith('office', 'ab12', {
        continueSessionId: undefined
      })
    )
  })

  it('at the limit switches to the best account and continues this chat', async () => {
    seed(limit('rejected', 100))
    render(<ClaudeLimitNotice sessionId="s1" />)
    expect(await screen.findByText('Personal reached its 5-hour limit')).toBeInTheDocument()
    expect(screen.getByText(/Switch to Work \(4% used\) and continue\?/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /switch to work and continue/i }))
    await waitFor(() =>
      expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledWith('office', 'ab12', {
        continueSessionId: 's1'
      })
    )
  })

  it('offers to continue when the window resets when no account has room', async () => {
    api.usage.mockResolvedValue([read('default', 100), read('ab12', 100), read('cd34', 100)])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const resetsAt = Math.floor(Date.now() / 1000) + 60
    seed(limit('rejected', 100, resetsAt))
    render(<ClaudeLimitNotice sessionId="s1" />)
    expect(await screen.findByText(/No other account has room left/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /continue when it resets/i }))
    expect(screen.getByText(/Continues at/)).toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(80_000)
    })
    expect(switcher.restartClaudeSession).toHaveBeenCalledWith('s1', {
      resend: true,
      cancelTurn: true
    })
  })

  it('ignores a rejected window that paid overage still covers', () => {
    seed({ ...limit('rejected', 100), overageInUse: true })
    const { container } = render(<ClaudeLimitNotice sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ClaudeAccountChip', () => {
  it('shows the project account and its usage, and switches from its menu', async () => {
    seed()
    render(<ClaudeAccountChip sessionId="s1" />)
    const chip = await screen.findByRole('button', { name: /Claude account: Personal, 100%/ })
    fireEvent.pointerDown(chip, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Work/ }))
    await waitFor(() =>
      expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledWith('office', 'ab12')
    )
  })

  it('renders nothing for a chat that is not a Claude chat', () => {
    seed()
    useAcpStore.setState({ configToLiveAgent: { 'acp-registry:gemini\0/work': 'a1' } })
    const { container } = render(<ClaudeAccountChip sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })
})
