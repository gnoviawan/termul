import type { CodexAccountsSnapshot } from '@shared/types/codex-accounts.types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCodexAccountDraft } from '@/hooks/use-project-codex-account-draft'
import { CodexProjectAccountSettings } from './CodexProjectAccountSettings'

const admits = vi.hoisted(() => ({ value: true }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => admits.value
}))
vi.mock('@/lib/codex-account-sign-in', () => ({
  CODEX_SIGN_IN_METHODS: [],
  signInCodexAccount: vi.fn()
}))

const snapshot: CodexAccountsSnapshot = {
  accounts: [
    { id: 'default', name: 'Personal', builtin: true, signedIn: true },
    { id: 'ab12', name: 'Work', builtin: false, signedIn: false }
  ],
  defaultAccountId: 'default',
  projectAccounts: {},
  autoSwitch: false
}

function draft(value: string | null = null): ProjectCodexAccountDraft {
  return {
    accounts: {
      snapshot,
      loading: false,
      error: null,
      reload: vi.fn()
    },
    value,
    dirty: false,
    setValue: vi.fn(),
    save: vi.fn(),
    reset: vi.fn()
  }
}

beforeEach(() => {
  admits.value = true
})

describe('CodexProjectAccountSettings', () => {
  it('lets a signed-in account be chosen and blocks a signed-out one', () => {
    const codex = draft()
    const onChange = vi.fn()
    render(
      <CodexProjectAccountSettings codex={codex} onChange={onChange} onManageAccounts={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('option', { name: /^Personal/ }))
    expect(codex.setValue).toHaveBeenCalledWith('default')
    expect(onChange).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: /Work/ }))
    expect(codex.setValue).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('follows the default when that row is chosen', () => {
    const codex = draft('default')
    render(
      <CodexProjectAccountSettings codex={codex} onChange={vi.fn()} onManageAccounts={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('option', { name: /Follow default/ }))
    expect(codex.setValue).toHaveBeenCalledWith(null)
  })
})
