import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage
} from '@shared/types/claude-accounts.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'
import { ProviderSettings } from './ProviderSettings'

const { api, toast } = vi.hoisted(() => ({
  api: {
    signInFlow: vi.fn(),
    startLinkLogin: vi.fn(),
    finishLinkLogin: vi.fn(),
    list: vi.fn(),
    usage: vi.fn(),
    add: vi.fn(),
    login: vi.fn(),
    cancelLogin: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    setDefault: vi.fn(),
    setProjectAccount: vi.fn(),
    setAutoSwitch: vi.fn()
  },
  toast: { success: vi.fn(), error: vi.fn() }
}))

vi.mock('@/lib/claude-accounts-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/claude-accounts-api')>(
    '@/lib/claude-accounts-api'
  )
  return { ...actual, claudeAccountsApi: api }
})
vi.mock('sonner', () => ({ toast }))

const SNAPSHOT: ClaudeAccountsSnapshot = {
  accounts: [
    { id: 'default', name: 'Personal', builtin: true, signedIn: true },
    { id: 'ab12', name: 'Work', builtin: false, signedIn: false }
  ],
  defaultAccountId: 'default',
  projectAccounts: { office: 'ab12' },
  autoSwitch: true
}

const window = (kind: string, percent: number, scope: string | null = null) => ({
  kind,
  group: null,
  scope,
  percent,
  resetsAt: null,
  severity: null
})

const USAGE: ClaudeAccountUsage[] = [
  {
    accountId: 'default',
    status: 'ok',
    subscriptionType: 'max',
    windows: [window('session', 84), window('weekly_all', 3), window('weekly_scoped', 0, 'Fable')],
    checkedAt: Date.now(),
    message: null
  },
  {
    accountId: 'ab12',
    status: 'signed_out',
    subscriptionType: null,
    windows: [],
    checkedAt: Date.now(),
    message: null
  }
]

const openMenu = (name: string): void => {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for ${name}` }), {
    button: 0,
    ctrlKey: false
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectStore.setState({
    projects: [{ id: 'office', name: 'm-pos', color: 'blue', path: '/code/m-pos' } as Project]
  })
  api.signInFlow.mockReturnValue('browser')
  api.startLinkLogin.mockResolvedValue('https://claude.com/cai/oauth/authorize?state=s1')
  api.finishLinkLogin.mockResolvedValue(undefined)
  api.list.mockResolvedValue(SNAPSHOT)
  api.usage.mockResolvedValue(USAGE)
  api.login.mockResolvedValue(undefined)
  api.cancelLogin.mockResolvedValue(true)
  api.rename.mockResolvedValue(undefined)
  api.remove.mockResolvedValue(['office'])
  api.setDefault.mockResolvedValue(undefined)
  api.setAutoSwitch.mockResolvedValue(undefined)
  api.add.mockResolvedValue({ id: 'cd34', name: 'Side', createdAt: 1 })
})

describe('ProviderSettings', () => {
  it('shows each account with its tightest window as the meter and the rest as chips', async () => {
    render(<ProviderSettings />)
    const personal = await screen.findByTestId('claude-account-default')
    expect(personal).toHaveTextContent('Personal')
    expect(personal).toHaveTextContent('Default')
    expect(personal).toHaveTextContent('Max · near the 5-hour limit')
    expect(personal).toHaveTextContent('84%')
    expect(personal).toHaveTextContent('Weekly3%')
    expect(personal).toHaveTextContent('Fable0%')
    expect(within(personal).getByRole('progressbar', { name: '5-hour usage' })).toHaveAttribute(
      'aria-valuenow',
      '84'
    )
    const work = screen.getByTestId('claude-account-ab12')
    expect(work).toHaveTextContent('signed out')
    expect(work).toHaveTextContent('Chats in projects that use Work cannot start until then.')
    expect(screen.getByText('2 accounts')).toBeInTheDocument()
  })

  it('opens a row to show every window', async () => {
    render(<ProviderSettings />)
    const toggle = await screen.findByRole('button', { name: 'Show all limits for Personal' })
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide all limits for Personal' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('5-hour session')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('claude-account-default')).getAllByRole('progressbar')
    ).toHaveLength(4)
  })

  it('signs a signed-out account in from its row and reads usage again', async () => {
    render(<ProviderSettings />)
    const work = await screen.findByTestId('claude-account-ab12')
    fireEvent.click(within(work).getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(api.login).toHaveBeenCalledWith('ab12'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Work is signed in'))
    expect(api.usage).toHaveBeenLastCalledWith(true)
  })

  it('waits for the browser and can cancel the sign-in quietly', async () => {
    api.login.mockReturnValue(new Promise(() => {}))
    render(<ProviderSettings />)
    const work = await screen.findByTestId('claude-account-ab12')
    fireEvent.click(within(work).getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/Finish signing in to Work in your browser/)).toBeInTheDocument()
    expect(work).toHaveTextContent('waiting for browser')
    fireEvent.click(within(work).getByRole('button', { name: 'Cancel' }))
    expect(api.cancelLogin).toHaveBeenCalledWith('ab12')
  })

  it('adds an account in one dialog: name, browser sign-in, done', async () => {
    render(<ProviderSettings />)
    await screen.findByTestId('claude-account-default')
    fireEvent.click(screen.getByRole('button', { name: /add account/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Side ' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(api.add).toHaveBeenCalledWith('Side'))
    await waitFor(() => expect(api.login).toHaveBeenCalledWith('cd34'))
    expect(await screen.findByText('Side is ready')).toBeInTheDocument()
    expect(screen.getByText('No — Personal stays default')).toBeInTheDocument()
  })

  it('suggests names that are not taken yet', async () => {
    render(<ProviderSettings />)
    await screen.findByTestId('claude-account-default')
    fireEvent.click(screen.getByRole('button', { name: /add account/i }))
    expect(screen.queryByRole('button', { name: 'Work' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Team' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Team')
  })

  it('shows a failed sign-in with Try again', async () => {
    api.login.mockRejectedValueOnce(new Error('Claude sign-in timed out'))
    render(<ProviderSettings />)
    await screen.findByTestId('claude-account-default')
    fireEvent.click(screen.getByRole('button', { name: /add account/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Side' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(await screen.findByText('Sign-in did not finish')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(2))
  })

  it('removes an account after a danger confirm that lists the projects that move', async () => {
    render(<ProviderSettings />)
    await screen.findByTestId('claude-account-ab12')
    openMenu('Work')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
    expect(
      await screen.findByText(/1 project moves to the default account \(Personal\)/)
    ).toBeInTheDocument()
    expect(screen.getByText('m-pos')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('ab12'))
  })

  it('makes a signed-in account the default from its menu', async () => {
    api.list.mockResolvedValue({
      ...SNAPSHOT,
      accounts: [SNAPSHOT.accounts[0], { ...SNAPSHOT.accounts[1], signedIn: true }]
    })
    api.usage.mockResolvedValue([USAGE[0], { ...USAGE[1], status: 'ok', subscriptionType: 'pro' }])
    render(<ProviderSettings />)
    await screen.findByTestId('claude-account-ab12')
    openMenu('Work')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make default' }))
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('ab12'))
  })

  it('does not make a signed-out account the default and says why', async () => {
    render(<ProviderSettings />)
    await screen.findByTestId('claude-account-ab12')
    openMenu('Work')
    const item = await screen.findByRole('menuitem', { name: /Make default/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('Make defaultSign in to it first')
    fireEvent.click(item)
    expect(api.setDefault).not.toHaveBeenCalled()
  })

  it('nudges to add a second account when there is only one', async () => {
    api.list.mockResolvedValue({
      ...SNAPSHOT,
      accounts: [SNAPSHOT.accounts[0]],
      projectAccounts: {}
    })
    render(<ProviderSettings />)
    expect(await screen.findByText('Keep work and personal apart')).toBeInTheDocument()
    expect(screen.getByText('1 account')).toBeInTheDocument()
  })

  it('turns automatic switching off on the host and shows the saved state', async () => {
    render(<ProviderSettings />)
    const toggle = await screen.findByRole('switch', { name: 'Switch accounts automatically' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveAccessibleDescription(
      "When a chat reaches its account's limit, continue it on the signed-in account with the most room."
    )
    api.list.mockResolvedValue({ ...SNAPSHOT, autoSwitch: false })
    fireEvent.click(toggle)
    expect(api.setAutoSwitch).toHaveBeenCalledWith(false)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })

  it('says why automatic switching did not change and shows the host state', async () => {
    api.setAutoSwitch.mockRejectedValue(new Error('disk full'))
    render(<ProviderSettings />)
    const toggle = await screen.findByRole('switch', { name: 'Switch accounts automatically' })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not change automatic switching: disk full')
    )
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  describe('on web', () => {
    beforeEach(() => {
      api.signInFlow.mockReturnValue('link')
    })

    it('offers the same row actions as the desktop app', async () => {
      render(<ProviderSettings />)
      await screen.findByTestId('claude-account-ab12')
      expect(screen.getByRole('button', { name: /add account/i })).toBeInTheDocument()
      expect(screen.queryByText(/termul-server claude account/)).not.toBeInTheDocument()
      expect(screen.getByRole('switch', { name: 'Switch accounts automatically' })).toBeEnabled()
      openMenu('Work')
      const items = await screen.findAllByRole('menuitem')
      expect(items.map((item) => item.textContent)).toEqual([
        'Make defaultSign in to it first',
        'Sign in',
        'Rename',
        'Remove'
      ])
    })

    it('never offers to remove the built-in account', async () => {
      render(<ProviderSettings />)
      await screen.findByTestId('claude-account-default')
      openMenu('Personal')
      expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: 'Remove' })).not.toBeInTheDocument()
    })

    it('renames an account and shows the name the host stored', async () => {
      render(<ProviderSettings />)
      await screen.findByTestId('claude-account-ab12')
      openMenu('Work')
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
      const dialog = await screen.findByRole('dialog', { name: 'Rename account' })
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Office' } })
      api.list.mockResolvedValue({
        ...SNAPSHOT,
        accounts: [SNAPSHOT.accounts[0], { ...SNAPSHOT.accounts[1], name: 'Office' }]
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() =>
        expect(screen.getByTestId('claude-account-ab12')).toHaveTextContent('Office')
      )
      expect(api.rename).toHaveBeenCalledWith('ab12', 'Office')
    })

    it('removes an account and drops it from the list', async () => {
      render(<ProviderSettings />)
      await screen.findByTestId('claude-account-ab12')
      openMenu('Work')
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
      expect(await screen.findByText(/1 project moves to the default account/)).toBeInTheDocument()
      api.list.mockResolvedValue({
        ...SNAPSHOT,
        accounts: [SNAPSHOT.accounts[0]],
        projectAccounts: {}
      })
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
      await waitFor(() =>
        expect(screen.queryByTestId('claude-account-ab12')).not.toBeInTheDocument()
      )
      expect(api.remove).toHaveBeenCalledWith('ab12')
      expect(toast.success).toHaveBeenCalledWith('Work was removed')
    })

    it('signs a signed-out account in from its row with a link and the pasted code', async () => {
      render(<ProviderSettings />)
      const work = await screen.findByTestId('claude-account-ab12')
      fireEvent.click(within(work).getByRole('button', { name: 'Sign in' }))
      const dialog = await screen.findByRole('dialog', { name: 'Sign in to Work' })
      await within(dialog).findByRole('link', { name: 'Open sign-in page' })
      expect(api.startLinkLogin).toHaveBeenCalledWith('ab12')
      fireEvent.change(within(dialog).getByLabelText('Code from the Claude page'), {
        target: { value: 'abc#def' }
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Finish sign-in' }))
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Work is signed in'))
      expect(api.finishLinkLogin).toHaveBeenCalledWith('ab12', 'abc#def')
      expect(api.login).not.toHaveBeenCalled()
      await waitFor(() => expect(api.usage).toHaveBeenLastCalledWith(true))
    })

    it('adds an account in one dialog: name, link sign-in, done', async () => {
      render(<ProviderSettings />)
      await screen.findByTestId('claude-account-default')
      fireEvent.click(screen.getByRole('button', { name: /add account/i }))
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Side' } })
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      await waitFor(() => expect(api.add).toHaveBeenCalledWith('Side'))
      await screen.findByRole('link', { name: 'Open sign-in page' })
      expect(api.startLinkLogin).toHaveBeenCalledWith('cd34')
      fireEvent.change(screen.getByLabelText('Code from the Claude page'), {
        target: { value: 'abc#def' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }))
      expect(await screen.findByText('Side is ready')).toBeInTheDocument()
      expect(api.finishLinkLogin).toHaveBeenCalledWith('cd34', 'abc#def')
      expect(api.login).not.toHaveBeenCalled()
    })

    it('closing the add dialog during the link sign-in stops it once', async () => {
      render(<ProviderSettings />)
      await screen.findByTestId('claude-account-default')
      fireEvent.click(screen.getByRole('button', { name: /add account/i }))
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Side' } })
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      await screen.findByRole('link', { name: 'Open sign-in page' })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(api.cancelLogin).toHaveBeenCalledWith('cd34'))
      expect(api.cancelLogin).toHaveBeenCalledOnce()
    })
  })

  it('shows one retry when the account list cannot be read', async () => {
    api.list.mockRejectedValueOnce(new Error('offline'))
    render(<ProviderSettings />)
    expect(
      await screen.findByText('Claude accounts are not available right now')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add account/i })).not.toBeInTheDocument()
    api.list.mockResolvedValueOnce(SNAPSHOT)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByTestId('claude-account-default')).toBeInTheDocument()
  })
})
