import type { ClaudeAccountView } from '@shared/types/claude-accounts.types'
import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpTransportError } from '@/lib/acp-transport/types'
import { LinkSignInDialog } from './LinkSignInDialog'

const { api, copyText } = vi.hoisted(() => ({
  api: {
    startLinkLogin: vi.fn(),
    finishLinkLogin: vi.fn(),
    cancelLogin: vi.fn()
  },
  copyText: vi.fn()
}))

vi.mock('@/lib/claude-accounts-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/claude-accounts-api')>(
    '@/lib/claude-accounts-api'
  )
  return { ...actual, claudeAccountsApi: api }
})
vi.mock('@/lib/copy-text', () => ({ copyText }))

const LINK = 'https://claude.com/cai/oauth/authorize?code=true&state=s1'
const WORK: ClaudeAccountView = { id: 'ab12', name: 'Work', builtin: false, signedIn: false }

function Harness({ onSignedIn = vi.fn() }: { onSignedIn?: () => void }): React.JSX.Element {
  const [account, setAccount] = useState<ClaudeAccountView | null>(WORK)
  return (
    <>
      <LinkSignInDialog
        account={account}
        onClose={() => setAccount(null)}
        onSignedIn={() => {
          setAccount(null)
          onSignedIn()
        }}
      />
      {account === null && <p>closed</p>}
    </>
  )
}

const codeField = (): HTMLElement => screen.getByLabelText('Code from the Claude page')
const finish = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  api.startLinkLogin.mockResolvedValue(LINK)
  api.finishLinkLogin.mockResolvedValue(undefined)
  api.cancelLogin.mockResolvedValue(true)
  copyText.mockResolvedValue(true)
})

describe('LinkSignInStep', () => {
  it('starts the sign-in and offers the link to open or copy', async () => {
    render(<Harness />)
    expect(screen.getByText('Getting the sign-in link…')).toBeInTheDocument()
    const open = await screen.findByRole('link', { name: 'Open sign-in page' })
    expect(api.startLinkLogin).toHaveBeenCalledWith('ab12')
    expect(open).toHaveAttribute('href', LINK)
    expect(open).toHaveAttribute('target', '_blank')
    expect(open).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByLabelText('Sign-in link')).toHaveValue(LINK)
    expect(screen.getByText(/signed in to another account on claude.ai/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(copyText).toHaveBeenCalledWith(LINK)
  })

  it('says so when the link cannot be copied', async () => {
    copyText.mockResolvedValue(false)
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
    expect(await screen.findByText(/Could not copy the link/)).toBeInTheDocument()
  })

  it('drops the whitespace a paste picks up and finishes with the code', async () => {
    const onSignedIn = vi.fn()
    render(<Harness onSignedIn={onSignedIn} />)
    await screen.findByRole('link', { name: 'Open sign-in page' })
    fireEvent.change(codeField(), { target: { value: '  abc#def\n' } })
    expect(codeField()).toHaveValue('abc#def')
    finish()
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce())
    expect(api.finishLinkLogin).toHaveBeenCalledWith('ab12', 'abc#def')
    expect(await screen.findByText('closed')).toBeInTheDocument()
    expect(api.cancelLogin).not.toHaveBeenCalled()
  })

  it('asks for the code instead of sending an empty one', async () => {
    render(<Harness />)
    await screen.findByRole('link', { name: 'Open sign-in page' })
    finish()
    expect(await screen.findByText('Paste the code from the Claude page.')).toBeInTheDocument()
    expect(api.finishLinkLogin).not.toHaveBeenCalled()
  })

  it('keeps waiting for the whole code after an incomplete one', async () => {
    api.finishLinkLogin.mockRejectedValueOnce(
      new AcpTransportError(
        WS_ERROR_CODES.CLAUDE_LOGIN_CODE_INCOMPLETE,
        'That code is incomplete. Copy the whole code from the Claude page.'
      )
    )
    const onSignedIn = vi.fn()
    render(<Harness onSignedIn={onSignedIn} />)
    await screen.findByRole('link', { name: 'Open sign-in page' })
    fireEvent.change(codeField(), { target: { value: 'abc' } })
    finish()
    expect(await screen.findByText(/That code is incomplete/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open sign-in page' })).toBeInTheDocument()

    fireEvent.change(codeField(), { target: { value: 'abc#def' } })
    expect(screen.queryByText(/That code is incomplete/)).not.toBeInTheDocument()
    finish()
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce())
    expect(api.startLinkLogin).toHaveBeenCalledOnce()
  })

  it('shows a rejected code as a failed sign-in that starts again', async () => {
    api.finishLinkLogin.mockRejectedValueOnce(
      new AcpTransportError(
        WS_ERROR_CODES.UNSUPPORTED,
        'Claude did not accept that code. Start the sign-in again.'
      )
    )
    render(<Harness />)
    await screen.findByRole('link', { name: 'Open sign-in page' })
    fireEvent.change(codeField(), { target: { value: 'x#y' } })
    finish()
    expect(await screen.findByText('Sign-in did not finish')).toBeInTheDocument()
    expect(screen.getByText(/Claude did not accept that code/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Code from the Claude page')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /start again/i }))
    await waitFor(() => expect(api.startLinkLogin).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('link', { name: 'Open sign-in page' })).toBeInTheDocument()
    expect(api.cancelLogin).not.toHaveBeenCalled()
  })

  it('shows a link that never came as a failed sign-in', async () => {
    api.startLinkLogin.mockRejectedValueOnce(
      new Error('The Claude CLI did not show a sign-in link. Try again.')
    )
    render(<Harness />)
    expect(await screen.findByText(/did not show a sign-in link/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start again/i })).toBeInTheDocument()
  })

  it('stops the sign-in on the host when the user cancels', async () => {
    render(<Harness />)
    await screen.findByRole('link', { name: 'Open sign-in page' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('closed')).toBeInTheDocument()
    expect(api.cancelLogin).toHaveBeenCalledOnce()
    expect(api.cancelLogin).toHaveBeenCalledWith('ab12')
  })

  it('stops the sign-in when the dialog is dismissed while the link loads', async () => {
    api.startLinkLogin.mockReturnValue(new Promise(() => {}))
    render(<Harness />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(await screen.findByText('closed')).toBeInTheDocument()
    expect(api.cancelLogin).toHaveBeenCalledWith('ab12')
  })
})
