import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectClaudeAccountDraft } from '@/hooks/use-project-claude-account-draft'
import { ProjectProviderSettings } from './ProjectProviderSettings'

const { api } = vi.hoisted(() => ({
  api: {
    list: vi.fn(),
    usage: vi.fn(),
    setProjectAccount: vi.fn(),
    login: vi.fn(),
    canManageAccounts: vi.fn()
  }
}))

vi.mock('@/lib/claude-accounts-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/claude-accounts-api')>(
    '@/lib/claude-accounts-api'
  )
  return { ...actual, claudeAccountsApi: api }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const snapshot = (projectAccounts: Record<string, string>, workSignedIn = true) => ({
  accounts: [
    { id: 'default', name: 'Personal', builtin: true, signedIn: true },
    { id: 'ab12', name: 'Work', builtin: false, signedIn: workSignedIn }
  ],
  defaultAccountId: 'default',
  projectAccounts
})

const read = (accountId: string, percent: number) => ({
  accountId,
  status: 'ok' as const,
  subscriptionType: 'max',
  windows: [{ kind: 'session', group: null, scope: null, percent, resetsAt: null, severity: null }],
  checkedAt: Date.now(),
  message: null
})

beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockResolvedValue(snapshot({ office: 'ab12' }))
  api.usage.mockResolvedValue([read('default', 6), read('ab12', 0)])
  api.setProjectAccount.mockResolvedValue(undefined)
  api.login.mockResolvedValue(undefined)
  api.canManageAccounts.mockReturnValue(true)
})

describe('useProjectClaudeAccountDraft', () => {
  it('reads nothing while the modal is closed', async () => {
    renderHook(() => useProjectClaudeAccountDraft('office', { enabled: false }))
    await Promise.resolve()
    expect(api.list).not.toHaveBeenCalled()
    expect(api.usage).not.toHaveBeenCalled()
  })

  it('starts from the saved choice, saves a change, and clears the draft', async () => {
    const { result } = renderHook(() => useProjectClaudeAccountDraft('office'))
    await waitFor(() => expect(result.current.value).toBe('ab12'))
    act(() => result.current.setValue(null))
    expect(result.current.dirty).toBe(true)
    api.list.mockResolvedValue(snapshot({}))
    await act(() => result.current.save())
    expect(api.setProjectAccount).toHaveBeenCalledWith('office', null)
    expect(result.current.dirty).toBe(false)
    expect(result.current.value).toBeNull()
  })

  it('reset returns to the saved choice without a request', async () => {
    const { result } = renderHook(() => useProjectClaudeAccountDraft('office'))
    await waitFor(() => expect(result.current.value).toBe('ab12'))
    act(() => result.current.setValue('default'))
    act(() => result.current.reset())
    expect(result.current.value).toBe('ab12')
    await act(() => result.current.save())
    expect(api.setProjectAccount).not.toHaveBeenCalled()
  })
})

function Harness({
  projectId,
  onChange = () => {},
  onManage = () => {}
}: {
  projectId: string
  onChange?: () => void
  onManage?: () => void
}): React.JSX.Element {
  const draft = useProjectClaudeAccountDraft(projectId)
  return <ProjectProviderSettings claude={draft} onChange={onChange} onManageAccounts={onManage} />
}

const option = (name: RegExp) => screen.findByRole('option', { name })

describe('ProjectProviderSettings', () => {
  it('selects Follow default for a project with no choice and names the default', async () => {
    render(<Harness projectId="side" />)
    const follow = await option(/Follow default/)
    expect(follow).toHaveAttribute('aria-selected', 'true')
    expect(follow).toHaveTextContent('Uses Personal now.')
    expect(await option(/Work/)).toHaveAttribute('aria-selected', 'false')
  })

  it('chooses an account by click and marks the form changed, without saving', async () => {
    const onChange = vi.fn()
    render(<Harness projectId="side" onChange={onChange} />)
    fireEvent.click(await option(/Work/))
    expect(onChange).toHaveBeenCalledOnce()
    expect(await option(/Work/)).toHaveAttribute('aria-selected', 'true')
    expect(await option(/Follow default/)).toHaveAttribute('aria-selected', 'false')
    expect(api.setProjectAccount).not.toHaveBeenCalled()
  })

  it('moves focus with the arrow keys and selects with Enter', async () => {
    render(<Harness projectId="side" />)
    await option(/Follow default/)
    const [follow, personal, work] = screen.getAllByRole('option')
    follow.focus()
    fireEvent.keyDown(follow, { key: 'ArrowDown' })
    expect(personal).toHaveFocus()
    fireEvent.keyDown(personal, { key: 'End' })
    expect(work).toHaveFocus()
    fireEvent.keyDown(work, { key: 'Enter' })
    expect(work).toHaveAttribute('aria-selected', 'true')
  })

  it('explains a signed-out chosen account and signs it in', async () => {
    api.list.mockResolvedValue(snapshot({ office: 'ab12' }, false))
    render(<Harness projectId="office" />)
    expect(await screen.findByText('Work is signed out')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(api.login).toHaveBeenCalledWith('ab12'))
  })

  it('offers the account with the most room when the chosen one hit its limit', async () => {
    api.usage.mockResolvedValue([read('default', 100), read('ab12', 4)])
    const onChange = vi.fn()
    render(<Harness projectId="side" onChange={onChange} />)
    expect(await screen.findByText('Personal reached its 5-hour limit')).toBeInTheDocument()
    expect(screen.getByText(/Work has the most room left \(4% used\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /use work/i }))
    expect(onChange).toHaveBeenCalledOnce()
    expect(await option(/Work/)).toHaveAttribute('aria-selected', 'true')
  })

  it('links to the account settings', async () => {
    const onManage = vi.fn()
    render(<Harness projectId="office" onManage={onManage} />)
    fireEvent.click(await screen.findByRole('button', { name: /manage accounts/i }))
    expect(onManage).toHaveBeenCalledOnce()
  })
})
