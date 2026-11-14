import type { CodexAccountUsage } from '@shared/types/codex-accounts.types'
import { fireEvent, render, screen } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { CodexLimitNotice } from './CodexLimitNotice'
import { CodexLimitWarning } from './CodexLimitWarning'
import { useCodexResumeStore } from './use-codex-limit'

const { api, switcher, openApp, admits } = vi.hoisted(() => ({
  admits: { value: true },
  openApp: vi.fn(),
  api: { list: vi.fn(), usage: vi.fn() },
  switcher: { switchProjectCodexAccount: vi.fn() }
}))

vi.mock('@/lib/codex-accounts-api', () => ({ codexAccountsApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/stores/settings-modal-store', () => ({
  useSettingsModalStore: (select: (state: { openApp: typeof openApp }) => unknown) =>
    select({ openApp })
}))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => admits.value
}))
vi.mock('@/stores/codex-account-switch', async () => {
  const actual = await vi.importActual<typeof import('@/stores/codex-account-switch')>(
    '@/stores/codex-account-switch'
  )
  return { ...actual, switchProjectCodexAccount: switcher.switchProjectCodexAccount }
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

beforeEach(() => {
  vi.clearAllMocks()
  admits.value = true
  seed()
  api.list.mockResolvedValue({
    accounts: [
      { id: 'default', name: 'Personal', builtin: true, signedIn: true },
      { id: 'ab12', name: 'Work', builtin: false, signedIn: true },
      { id: 'cd34', name: 'Side', builtin: false, signedIn: true }
    ],
    defaultAccountId: 'default',
    projectAccounts: {},
    autoSwitch: true
  })
  switcher.switchProjectCodexAccount.mockResolvedValue(['s1'])
})

describe('CodexLimitWarning', () => {
  it('warns in yellow when the 5-hour window is near 80%', async () => {
    api.usage.mockResolvedValue([read('default', 82), read('ab12', 10), read('cd34', 40)])
    render(<CodexLimitWarning sessionId="s1" atTop />)
    const warning = await screen.findByTestId('codex-limit-warning')
    expect(warning).toHaveTextContent('Personal has used 82% of its 5-hour limit')
    expect(warning.className).toContain('text-warning')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Work' }))
    await vi.waitFor(() =>
      expect(switcher.switchProjectCodexAccount).toHaveBeenCalledWith('office', 'ab12', {
        continueSessionIds: undefined,
        expectedAccountId: 'default'
      })
    )
  })

  it('stays hidden under 80%', async () => {
    api.usage.mockResolvedValue([read('default', 79)])
    const { container } = render(<CodexLimitWarning sessionId="s1" atTop />)
    await vi.waitFor(() => expect(api.usage).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})

describe('CodexLimitNotice', () => {
  it('offers Switch to the account with the most room and Other account', async () => {
    api.usage.mockResolvedValue([read('default', 100), read('ab12', 4), read('cd34', 40)])
    render(<CodexLimitNotice sessionId="s1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Personal reached its 5-hour limit')
    const switchButton = screen.getByRole('button', { name: 'Switch to Work and continue' })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Other account' }), {
      button: 0,
      ctrlKey: false
    })
    expect(await screen.findByRole('menuitem', { name: /Side/ })).toHaveTextContent('40% used')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.click(switchButton)
    await vi.waitFor(() =>
      expect(switcher.switchProjectCodexAccount).toHaveBeenCalledWith('office', 'ab12', {
        continueSessionIds: ['s1'],
        expectedAccountId: 'default'
      })
    )
  })

  it('reports a lost compare-and-set instead of a successful switch', async () => {
    switcher.switchProjectCodexAccount.mockResolvedValue(null)
    api.usage.mockResolvedValue([read('default', 100), read('ab12', 4), read('cd34', 40)])
    render(<CodexLimitNotice sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Work and continue' }))
    await vi.waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('That account was changed on another client')
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('keeps Cancel visible when a resume is scheduled and another account has room', async () => {
    api.usage.mockResolvedValue([read('default', 100), read('ab12', 4), read('cd34', 40)])
    useCodexResumeStore.getState().schedule('s1', Date.now() + 60_000)
    render(<CodexLimitNotice sessionId="s1" />)
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch to Work and continue' })).toBeInTheDocument()
    useCodexResumeStore.getState().cancel('s1')
  })

  it('offers wait for reset and Add account when no other account has room', async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
    api.usage.mockResolvedValue([
      read('default', 100, resetsAt),
      read('ab12', 100, resetsAt),
      read('cd34', 100, resetsAt)
    ])
    render(<CodexLimitNotice sessionId="s1" />)
    expect(
      await screen.findByRole('button', { name: 'Continue when it resets' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add account' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    expect(openApp).toHaveBeenCalledWith('provider')
  })

  it('treats a mid-turn rate limit as at-limit and keeps the last probe reset', async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
    api.usage.mockResolvedValue([
      read('default', 40, resetsAt),
      read('ab12', 100),
      read('cd34', 100)
    ])
    useAcpStore.getState()._onAgentError({
      agentId: 'a1',
      sessionId: 's1',
      message: 'usage limit',
      code: -32603,
      data: { errorKind: 'rate_limited' }
    })
    render(<CodexLimitNotice sessionId="s1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Personal reached its 5-hour limit')
    expect(screen.getByRole('button', { name: 'Continue when it resets' })).toBeInTheDocument()
  })
})
