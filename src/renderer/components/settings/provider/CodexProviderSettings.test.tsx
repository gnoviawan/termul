import type { CodexAccountsSnapshot } from '@shared/types/codex-accounts.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'
import { CodexProviderSettings } from './CodexProviderSettings'

const { api, toast, admits, applyProjectCodexAccount, signInCodexAccount } = vi.hoisted(() => ({
  admits: { value: true },
  applyProjectCodexAccount: vi.fn(),
  signInCodexAccount: vi.fn(),
  api: {
    list: vi.fn(),
    add: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    setDefault: vi.fn(),
    setProjectAccount: vi.fn(),
    setAutoSwitch: vi.fn(),
    startLogin: vi.fn(),
    usage: vi.fn()
  },
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/lib/codex-accounts-api', () => ({ codexAccountsApi: api }))
vi.mock('@/lib/codex-account-sign-in', () => ({
  CODEX_SIGN_IN_METHODS: [
    { id: 'chat-gpt', label: 'Sign in with ChatGPT' },
    { id: 'chat-gpt-device-code', label: 'Use a device code' }
  ],
  isCodexSignInMethod: (id: string) => id === 'chat-gpt' || id === 'chat-gpt-device-code',
  signInCodexAccount
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/stores/codex-account-switch', () => ({ applyProjectCodexAccount }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => admits.value
}))

const SNAPSHOT: CodexAccountsSnapshot = {
  accounts: [
    { id: 'default', name: 'Personal', builtin: true, signedIn: true },
    { id: 'ab12', name: 'Work', builtin: false, signedIn: false }
  ],
  defaultAccountId: 'default',
  projectAccounts: { office: 'ab12' },
  autoSwitch: true
}

const openMenu = (name: string): void => {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for ${name}` }), {
    button: 0,
    ctrlKey: false
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  admits.value = true
  useProjectStore.setState({
    projects: [{ id: 'office', name: 'm-pos', color: 'blue', path: '/code/m-pos' } as Project]
  })
  api.list.mockResolvedValue(SNAPSHOT)
  api.add.mockResolvedValue({ id: 'cd34', name: 'Side', createdAt: 1 })
  api.rename.mockResolvedValue(undefined)
  api.remove.mockResolvedValue(['office'])
  api.setDefault.mockResolvedValue(undefined)
  api.setAutoSwitch.mockResolvedValue(undefined)
  api.usage.mockResolvedValue([])
  signInCodexAccount.mockResolvedValue(undefined)
  applyProjectCodexAccount.mockResolvedValue([])
})

describe('CodexProviderSettings', () => {
  it('lists each Codex account and automatic switching', async () => {
    render(<CodexProviderSettings />)
    const personal = await screen.findByTestId('codex-account-default')
    expect(personal).toHaveTextContent('Personal')
    expect(personal).toHaveTextContent('Default')
    expect(personal).toHaveTextContent('Signed in')
    const work = screen.getByTestId('codex-account-ab12')
    expect(work).toHaveTextContent('Work')
    expect(work).toHaveTextContent('Signed out')
    expect(work).toHaveTextContent('m-pos')
    expect(screen.getByLabelText('Switch accounts automatically')).toBeChecked()
    expect(
      screen.getByText(/continue it on the signed-in account with the most room/)
    ).toBeInTheDocument()
  })

  it('shows 5-hour and weekly usage bars', async () => {
    api.usage.mockResolvedValue([
      {
        accountId: 'default',
        status: 'ok',
        planType: 'plus',
        windows: [
          {
            kind: 'session',
            percent: 82,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
            windowDurationMins: 300
          },
          {
            kind: 'weekly',
            percent: 10,
            resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
            windowDurationMins: 10080
          }
        ],
        checkedAt: Date.now(),
        message: null
      }
    ])
    render(<CodexProviderSettings />)
    const personal = await screen.findByTestId('codex-account-default')
    await waitFor(() => expect(personal).toHaveTextContent('82%'))
    expect(personal).toHaveTextContent('5-hour')
    expect(personal).toHaveTextContent('Weekly')
    expect(within(personal).getByRole('progressbar', { name: '5-hour usage' })).toHaveAttribute(
      'aria-valuenow',
      '82'
    )
  })

  it('stores the automatic-switching flag without switching chats', async () => {
    render(<CodexProviderSettings />)
    fireEvent.click(await screen.findByLabelText('Switch accounts automatically'))
    await waitFor(() => expect(api.setAutoSwitch).toHaveBeenCalledWith(false))
    expect(applyProjectCodexAccount).not.toHaveBeenCalled()
  })

  it('adds an account and offers ChatGPT sign-in', async () => {
    render(<CodexProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Side' } })
    const addButtons = screen.getAllByRole('button', { name: 'Add account' })
    fireEvent.click(addButtons[addButtons.length - 1])
    await waitFor(() => expect(api.add).toHaveBeenCalledWith('Side'))
    expect(await screen.findByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use a device code' }))
    await waitFor(() =>
      expect(signInCodexAccount).toHaveBeenCalledWith('cd34', 'chat-gpt-device-code')
    )
  })

  it('renames, sets the default, and removes with a project move', async () => {
    api.list.mockResolvedValue({
      ...SNAPSHOT,
      accounts: [SNAPSHOT.accounts[0], { ...SNAPSHOT.accounts[1], signedIn: true }]
    })
    render(<CodexProviderSettings />)
    await screen.findByTestId('codex-account-ab12')
    openMenu('Work')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Office' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('ab12', 'Office'))

    openMenu('Personal')
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).not.toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape' })

    openMenu('Work')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make default' }))
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('ab12'))

    openMenu('Work')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('ab12'))
    expect(applyProjectCodexAccount).toHaveBeenCalledWith('office')
  })

  it('does not make a signed-out account the default', async () => {
    render(<CodexProviderSettings />)
    await screen.findByTestId('codex-account-ab12')
    openMenu('Work')
    const item = await screen.findByRole('menuitem', { name: /Make default/ })
    expect(item).toHaveAttribute('data-disabled')
    fireEvent.click(item)
    expect(api.setDefault).not.toHaveBeenCalled()
  })

  it('hides writes on a view-only connection', async () => {
    admits.value = false
    render(<CodexProviderSettings />)
    await screen.findByTestId('codex-account-default')
    expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Switch accounts automatically')).toBeDisabled()
    expect(screen.getByText(/troupe-server codex account/)).toBeInTheDocument()
  })
})
