import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { CodexAccountChip } from './CodexAccountChip'

const { api, switcher, openApp } = vi.hoisted(() => ({
  openApp: vi.fn(),
  api: { list: vi.fn(), usage: vi.fn() },
  switcher: { switchProjectCodexAccount: vi.fn() }
}))

vi.mock('@/lib/codex-accounts-api', () => ({ codexAccountsApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/stores/settings-modal-store', () => ({
  useSettingsModalStore: (select: (s: { openApp: typeof openApp }) => unknown) =>
    select({ openApp })
}))
vi.mock('@/stores/codex-account-switch', async () => {
  const actual = await vi.importActual<typeof import('@/stores/codex-account-switch')>(
    '@/stores/codex-account-switch'
  )
  return { ...actual, switchProjectCodexAccount: switcher.switchProjectCodexAccount }
})

beforeEach(() => {
  vi.clearAllMocks()
  api.usage.mockResolvedValue([])
  api.list.mockResolvedValue({
    accounts: [
      { id: 'default', name: 'Personal', builtin: true, signedIn: true },
      { id: 'ab12', name: 'Work', builtin: false, signedIn: true },
      { id: 'cd34', name: 'Side', builtin: false, signedIn: false }
    ],
    defaultAccountId: 'default',
    projectAccounts: { office: 'ab12' },
    autoSwitch: false
  })
  switcher.switchProjectCodexAccount.mockResolvedValue([])
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
    configToLiveAgent: { 'acp-registry:codex-acp\0/work\0project\0office': 'a1' }
  } as never)
})

describe('CodexAccountChip', () => {
  it('shows the project account and switches it', async () => {
    render(<CodexAccountChip sessionId="s1" />)
    const chip = await screen.findByTestId('codex-account-chip')
    expect(chip).toHaveTextContent('Work')
    fireEvent.pointerDown(chip, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Personal/ }))
    await waitFor(() =>
      expect(switcher.switchProjectCodexAccount).toHaveBeenCalledWith('office', 'default')
    )
  })

  it('does not offer a signed-out account', async () => {
    render(<CodexAccountChip sessionId="s1" />)
    fireEvent.pointerDown(await screen.findByTestId('codex-account-chip'), {
      button: 0,
      ctrlKey: false
    })
    const side = await screen.findByRole('menuitem', { name: /Side/ })
    expect(side).toHaveAttribute('data-disabled')
  })

  it('renders nothing for a chat that is not Codex', () => {
    useAcpStore.setState({
      configToLiveAgent: { 'acp-registry:claude-acp\0/work\0project\0office': 'a1' }
    } as never)
    const { container } = render(<CodexAccountChip sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })
})
