import type { ClaudeRateLimit } from '@shared/types/claude-accounts.types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpTransportError } from '@/lib/acp-transport/types'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { UsageCard } from '../agent-model-selector/mobile/MobileUsageCard'
import { ClaudeAccountChip } from './ClaudeAccountChip'
import { ClaudeLimitNotice } from './ClaudeLimitNotice'
import { ClaudeLimitWarning } from './ClaudeLimitWarning'
import { ClaudeSignInAction } from './ClaudeSignInAction'
import { setSwitchingTo, useClaudeResumeStore } from './use-claude-limit'

const { api, switcher, openApp, admits } = vi.hoisted(() => ({
  openApp: vi.fn(),
  admits: { value: true },
  api: { list: vi.fn(), usage: vi.fn() },
  switcher: { switchProjectClaudeAccount: vi.fn(), restartClaudeSession: vi.fn() }
}))

vi.mock('@/lib/claude-accounts-api', () => ({ claudeAccountsApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => admits.value
}))
vi.mock('@/stores/settings-modal-store', () => ({
  useSettingsModalStore: Object.assign(
    (select: (s: { openApp: typeof openApp }) => unknown) => select({ openApp }),
    { getState: () => ({ openApp }) }
  )
}))
vi.mock('@/stores/claude-account-switch', async () => {
  const actual = await vi.importActual<typeof import('@/stores/claude-account-switch')>(
    '@/stores/claude-account-switch'
  )
  return { ...actual, ...switcher }
})

const usageWindow = (kind: string, percent: number) => ({
  kind,
  group: null,
  scope: null,
  percent,
  resetsAt: null,
  severity: null
})

const read = (accountId: string, percent: number, weekly?: number) => ({
  accountId,
  status: 'ok' as const,
  subscriptionType: 'max',
  windows: [
    usageWindow('session', percent),
    ...(weekly === undefined ? [] : [usageWindow('weekly_all', weekly)])
  ],
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
  admits.value = true
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

  it('leaves the near-limit warning to the composer', async () => {
    seed(limit('allowed_warning', 84))
    render(
      <>
        <ClaudeLimitNotice sessionId="s1" />
        <ClaudeLimitWarning sessionId="s1" atTop />
      </>
    )
    expect(await screen.findByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('at the limit switches to the best account and continues this chat', async () => {
    seed(limit('rejected', 100))
    render(<ClaudeLimitNotice sessionId="s1" />)
    expect(await screen.findByText('Personal reached its 5-hour limit')).toBeInTheDocument()
    expect(screen.getByText(/Switch to Work \(4% used\) and continue\?/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /switch to work and continue/i }))
    await waitFor(() =>
      expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledWith('office', 'ab12', {
        continueSessionIds: ['s1']
      })
    )
  })

  it('shows a switch that automatic switching started, without the offer', async () => {
    seed(limit('rejected', 100))
    setSwitchingTo('s1', 'Work')
    render(<ClaudeLimitNotice sessionId="s1" />)
    expect(await screen.findByText('Switching to Work and continuing…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /switch to work and continue/i })).toBeNull()
    act(() => setSwitchingTo('s1', null))
    expect(
      await screen.findByRole('button', { name: /switch to work and continue/i })
    ).toBeInTheDocument()
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

  it('offers to add an account when no account has room, except on a view-only connection', async () => {
    api.usage.mockResolvedValue([read('default', 100), read('ab12', 100), read('cd34', 100)])
    seed(limit('rejected', 100))
    const { unmount } = render(<ClaudeLimitNotice sessionId="s1" />)
    expect(await screen.findByText(/No other account has room left/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    expect(openApp).toHaveBeenCalledWith('provider')
    unmount()

    admits.value = false
    render(<ClaudeLimitNotice sessionId="s1" />)
    expect(await screen.findByText(/No other account has room left/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument()
  })

  it('ignores a rejected window that paid overage still covers', () => {
    seed({ ...limit('rejected', 100), overageInUse: true })
    const { container } = render(<ClaudeLimitNotice sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('appears when a turn is rejected at the limit', async () => {
    seed()
    render(<ClaudeLimitNotice sessionId="s1" />)
    act(() =>
      useAcpStore.getState()._onAgentError({
        agentId: 'a1',
        sessionId: 's1',
        message: "Internal error: You've hit your 5-hour limit · resets 4am (Europe/Berlin)",
        providerCode: 'provider_quota_exceeded'
      })
    )
    expect(await screen.findByText('Personal reached its 5-hour limit')).toBeInTheDocument()
    expect(screen.getByText(/Switch to Work \(4% used\) and continue\?/)).toBeInTheDocument()
  })
})

describe('ClaudeLimitWarning', () => {
  it('warns calmly near the limit and offers the account with the most room', async () => {
    seed(limit('allowed_warning', 84))
    render(<ClaudeLimitWarning sessionId="s1" atTop />)
    expect(await screen.findByText(/Personal has used 84% of its 5-hour limit/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Work' }))
    await waitFor(() =>
      expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledWith('office', 'ab12', {
        continueSessionIds: undefined
      })
    )
  })

  it('warns from 80% of an allowed window', async () => {
    seed(limit('allowed', 80))
    render(<ClaudeLimitWarning sessionId="s1" atTop />)
    expect(await screen.findByText(/Personal has used 80%/)).toBeInTheDocument()
  })

  it('hides after Dismiss', async () => {
    seed(limit('allowed_warning', 91, 1_900_000_000))
    render(<ClaudeLimitWarning sessionId="s1" atTop />)
    await screen.findByText(/Personal has used 91%/)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('leaves the at-limit state to the card', async () => {
    seed(limit('rejected', 100))
    render(
      <>
        <ClaudeLimitNotice sessionId="s1" />
        <ClaudeLimitWarning sessionId="s1" atTop />
      </>
    )
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('phone Select model sheet usage', () => {
  it('shows the project account and its 5-hour reading', async () => {
    api.usage.mockResolvedValue([read('default', 42), read('ab12', 4), read('cd34', 40)])
    seed()
    render(<UsageCard sessionId="s1" usage={null} compact={null} onManageAccounts={vi.fn()} />)

    expect(await screen.findByText('5-hour limit · Personal')).toBeInTheDocument()
    expect(screen.getByText('Usage')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('says a signed-out account is signed out and opens account settings from the row', async () => {
    api.list.mockResolvedValue({
      accounts: [{ id: 'default', name: 'Personal', builtin: true, signedIn: false }],
      defaultAccountId: 'default',
      projectAccounts: {}
    })
    seed()
    const onManageAccounts = vi.fn()
    render(
      <UsageCard sessionId="s1" usage={null} compact={null} onManageAccounts={onManageAccounts} />
    )

    const row = await screen.findByRole('button', { name: /Claude account/ })
    expect(row).toHaveTextContent('Signed out · Personal')
    expect(row).toHaveTextContent('Sign in')
    fireEvent.click(row)
    expect(onManageAccounts).toHaveBeenCalledTimes(1)
  })
})

describe('ClaudeAccountChip', () => {
  it('shows the project account and its usage, and switches from its menu', async () => {
    seed()
    render(<ClaudeAccountChip sessionId="s1" />)
    const chip = await screen.findByRole('button', {
      name: 'Claude account: Personal, 5-hour 100% used. Change account'
    })
    expect(chip).toHaveTextContent(/^Personal5h 100%$/)
    fireEvent.pointerDown(chip, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Work/ }))
    await waitFor(() =>
      expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledWith('office', 'ab12')
    )
  })

  it('adds a weekly window only once it nears its limit', async () => {
    api.usage.mockResolvedValue([read('default', 42, 86), read('ab12', 4, 60), read('cd34', 40)])
    seed()
    render(<ClaudeAccountChip sessionId="s1" />)
    const chip = await screen.findByRole('button', {
      name: 'Claude account: Personal, 5-hour 42% used, weekly 86% used. Change account'
    })
    expect(chip).toHaveTextContent(/^Personal5h 42%·Wk 86%$/)
    fireEvent.pointerDown(chip, { button: 0, ctrlKey: false })
    expect(await screen.findByRole('menuitem', { name: /^Personal/ })).toHaveTextContent(
      'Max · 5-hour 42% · Weekly 86%'
    )
    expect(screen.getByRole('menuitem', { name: /Work/ })).toHaveTextContent(
      'Max · 5-hour 4% · Weekly 60%'
    )
    expect(screen.getByRole('menuitem', { name: /Side/ })).toHaveTextContent('Max · 5-hour 40%')
  })

  it('announces no usage for a signed-out account', async () => {
    api.list.mockResolvedValue({
      accounts: [{ id: 'default', name: 'Personal', builtin: true, signedIn: false }],
      defaultAccountId: 'default',
      projectAccounts: {}
    })
    seed(limit('allowed', 31))
    render(<ClaudeAccountChip sessionId="s1" />)
    const chip = await screen.findByRole('button', {
      name: 'Claude account: Personal. Change account'
    })
    expect(chip).toHaveTextContent(/^Personal$/)
  })

  it('keeps only the 5-hour window below the warning level', async () => {
    api.usage.mockResolvedValue([read('default', 42, 79), read('ab12', 4), read('cd34', 40)])
    seed()
    render(<ClaudeAccountChip sessionId="s1" />)
    const chip = await screen.findByRole('button', {
      name: 'Claude account: Personal, 5-hour 42% used. Change account'
    })
    expect(chip).toHaveTextContent(/^Personal5h 42%$/)
  })

  it('shows the live 5-hour reading and a live weekly one beside it', async () => {
    seed(limit('allowed', 31))
    const { unmount } = render(<ClaudeAccountChip sessionId="s1" />)
    expect(await screen.findByRole('button', { name: /Claude account/ })).toHaveTextContent(
      /^Personal5h 31%$/
    )
    unmount()
    seed({ ...limit('allowed_warning', 91), kind: 'seven_day' })
    render(<ClaudeAccountChip sessionId="s1" />)
    expect(await screen.findByRole('button', { name: /Claude account/ })).toHaveTextContent(
      /^Personal5h 100%·Wk 91%$/
    )
  })

  it('renders nothing for a chat that is not a Claude chat', () => {
    seed()
    useAcpStore.setState({ configToLiveAgent: { 'acp-registry:gemini\0/work': 'a1' } })
    const { container } = render(<ClaudeAccountChip sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })

  async function openMenu(): Promise<void> {
    const chip = await screen.findByRole('button', { name: /Claude account: Personal/ })
    fireEvent.pointerDown(chip, { button: 0, ctrlKey: false })
    await screen.findByRole('menuitem', { name: /Follow default/ })
  }

  it('does not switch to a signed-out account and says why', async () => {
    api.list.mockResolvedValue({
      accounts: [
        { id: 'default', name: 'Personal', builtin: true, signedIn: true },
        { id: 'ab12', name: 'Work', builtin: false, signedIn: false },
        { id: 'cd34', name: 'Side', builtin: false, signedIn: true }
      ],
      defaultAccountId: 'default',
      projectAccounts: {}
    })
    seed()
    render(<ClaudeAccountChip sessionId="s1" />)
    await openMenu()
    const work = screen.getByRole('menuitem', { name: /Work/ })
    expect(work).toHaveAttribute('aria-disabled', 'true')
    expect(work).toHaveTextContent(/Signed out/)
    fireEvent.click(work)
    fireEvent.click(screen.getByRole('menuitem', { name: /Side/ }))
    await waitFor(() =>
      expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledWith('office', 'cd34')
    )
    expect(switcher.switchProjectClaudeAccount).toHaveBeenCalledTimes(1)
  })

  it('does not switch to an account whose sign-in the host could not confirm', async () => {
    api.list.mockResolvedValue({
      accounts: [
        { id: 'default', name: 'Personal', builtin: true, signedIn: true },
        { id: 'ab12', name: 'Work', builtin: false, signedIn: null }
      ],
      defaultAccountId: 'default',
      projectAccounts: {}
    })
    seed()
    render(<ClaudeAccountChip sessionId="s1" />)
    await openMenu()
    const work = screen.getByRole('menuitem', { name: /Work/ })
    expect(work).toHaveAttribute('aria-disabled', 'true')
    expect(work).toHaveTextContent(/Could not check sign-in/)
    fireEvent.click(work)
    expect(switcher.switchProjectClaudeAccount).not.toHaveBeenCalled()
  })

  it('does not follow a default account that is signed out', async () => {
    api.list.mockResolvedValue({
      accounts: [
        { id: 'default', name: 'Personal', builtin: true, signedIn: false },
        { id: 'ab12', name: 'Work', builtin: false, signedIn: true }
      ],
      defaultAccountId: 'default',
      projectAccounts: { office: 'ab12' }
    })
    seed()
    render(<ClaudeAccountChip sessionId="s1" />)
    const chip = await screen.findByRole('button', { name: /Claude account: Work/ })
    fireEvent.pointerDown(chip, { button: 0, ctrlKey: false })
    const follow = await screen.findByRole('menuitem', { name: /Follow default/ })
    expect(follow).toHaveAttribute('aria-disabled', 'true')
    expect(follow).toHaveTextContent(/Personal.*signed out/i)
    fireEvent.click(follow)
    expect(switcher.switchProjectClaudeAccount).not.toHaveBeenCalled()
  })

  it('shows the host reason and a way to sign in when the host refuses the account', async () => {
    const reason =
      'The Claude account "Work" is not signed in. Sign in to it in Settings → Accounts, then choose it again.'
    switcher.switchProjectClaudeAccount.mockRejectedValue(
      new AcpTransportError('claude_account_signed_out', reason)
    )
    seed()
    render(<ClaudeAccountChip sessionId="s1" />)
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Work/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const [title, options] = vi.mocked(toast.error).mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } }
    ]
    expect(title).toBe(reason)
    expect(options.action.label).toBe('Open Accounts')
    options.action.onClick()
    expect(openApp).toHaveBeenCalledWith('provider')
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('ClaudeSignInAction', () => {
  it('offers the Accounts page when the chat stopped on a signed-out account', async () => {
    api.list.mockResolvedValue({
      accounts: [{ id: 'default', name: 'Personal', builtin: true, signedIn: false }],
      defaultAccountId: 'default',
      projectAccounts: {}
    })
    seed()
    render(<ClaudeSignInAction sessionId="s1" />)
    expect(await screen.findByText('Personal: signed out')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Accounts' }))
    expect(openApp).toHaveBeenCalledWith('provider')
  })

  it('shows nothing while the account is signed in', async () => {
    seed()
    const { container } = render(<ClaudeSignInAction sessionId="s1" />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
