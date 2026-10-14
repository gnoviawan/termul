import type { SSHProfile } from '@shared/types/ssh.types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '@/lib/copy-text'
import type { SSHSession } from '@/stores/ssh-store'
import { SSHConnectionPanel } from './SSHConnectionPanel'

const { sessions } = vi.hoisted(() => ({
  sessions: {
    cancelSSHSession: vi.fn(),
    closeSSHSession: vi.fn(async () => {}),
    respondSSHHostKey: vi.fn(async () => {}),
    retrySSHSession: vi.fn()
  }
}))
vi.mock('@/lib/ssh-sessions', () => sessions)
vi.mock('@/lib/copy-text', () => ({ copyText: vi.fn(async () => true) }))

const profile: SSHProfile = {
  id: 'p1',
  name: 'Web',
  host: 'web.example',
  port: 2222,
  username: 'deploy',
  authMethod: 'password',
  portForwards: []
}

function session(overrides: Partial<SSHSession>): SSHSession {
  return {
    id: 'tab',
    attemptId: 'attempt',
    profileId: 'p1',
    status: 'connecting',
    stage: 'connecting',
    hostKeyPrompt: null,
    credentialPrompt: null,
    error: null,
    ended: null,
    ptyId: null,
    claim: null,
    attached: false,
    connectedAt: null,
    ...overrides
  }
}

function renderPanel(overrides: Partial<SSHSession>, p: SSHProfile = profile) {
  const onEditHost = vi.fn()
  render(<SSHConnectionPanel session={session(overrides)} profile={p} onEditHost={onEditHost} />)
  return { onEditHost }
}

beforeEach(() => vi.clearAllMocks())

describe('progress', () => {
  it('lists the steps with the current one marked, and can cancel', () => {
    renderPanel({ stage: 'authenticating' })
    const steps = screen.getAllByRole('listitem')
    expect(steps.map((s) => s.textContent)).toEqual([
      'Connect to web.example:2222(done)',
      'Verify server identity(done)',
      'Sign in as deploy(in progress)',
      'Open shell(waiting)'
    ])
    expect(steps[2]).toHaveAttribute('aria-current', 'step')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(sessions.cancelSSHSession).toHaveBeenCalledWith('tab')
  })
})

describe('host key', () => {
  const prompt = {
    sessionId: 'attempt',
    host: 'web.example',
    port: 2222,
    keyType: 'ssh-ed25519',
    fingerprint: 'SHA256:abcdef'
  }

  it('asks to trust a first-seen key and shows its fingerprint', () => {
    renderPanel({ status: 'awaitingInput', hostKeyPrompt: { ...prompt, status: 'unknown' } })
    expect(screen.getByRole('heading', { name: 'Verify this server' })).toBeInTheDocument()
    expect(screen.getByText('SHA256:abcdef')).toBeInTheDocument()
    expect(screen.getByText('ssh-ed25519 key fingerprint')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }))
    expect(sessions.respondSSHHostKey).toHaveBeenCalledWith('tab', true)
  })

  it('only confirms a copy of the fingerprint that worked', async () => {
    vi.mocked(copyText).mockResolvedValueOnce(false)
    renderPanel({ status: 'awaitingInput', hostKeyPrompt: { ...prompt, status: 'unknown' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy fingerprint' }))
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Copy fingerprint' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy fingerprint' }))
    expect(await screen.findByRole('button', { name: 'Fingerprint copied' })).toBeInTheDocument()
  })

  it('warns about a changed key, focuses Cancel and uses a destructive confirm', () => {
    renderPanel({ status: 'awaitingInput', hostKeyPrompt: { ...prompt, status: 'changed' } })
    expect(screen.getByRole('heading', { name: 'Server identity changed' })).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(sessions.respondSSHHostKey).toHaveBeenCalledWith('tab', false)
    expect(screen.getByRole('button', { name: 'Replace key and connect' }).className).toContain(
      'destructive'
    )
  })
})

describe('credentials', () => {
  it('asks for the password and connects with it, optionally saving it', () => {
    renderPanel({
      status: 'awaitingInput',
      credentialPrompt: { kind: 'password', reason: 'required' }
    })
    const input = screen.getByLabelText('Password')
    expect(input).toHaveAttribute('type', 'password')
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 's3cret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(input).toHaveAttribute('type', 'text')
    fireEvent.click(screen.getByRole('switch', { name: 'Save in system keychain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(sessions.retrySSHSession).toHaveBeenCalledWith('tab', {
      secret: 's3cret',
      saveSecret: true
    })
  })

  it('says why when the password was rejected', () => {
    renderPanel({
      status: 'awaitingInput',
      credentialPrompt: { kind: 'password', reason: 'rejected' }
    })
    expect(screen.getByRole('alert')).toHaveTextContent('That password was not accepted')
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true')
  })

  it('asks for a key passphrase and needs one before connecting', () => {
    renderPanel(
      { status: 'awaitingInput', credentialPrompt: { kind: 'passphrase', reason: 'required' } },
      { ...profile, authMethod: 'key', privateKeyPath: '~/.ssh/id_ed25519' }
    )
    expect(screen.getByRole('heading', { name: 'Unlock private key' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'pp' } })
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })
})

describe('failure', () => {
  it('explains the error, keeps technical details and offers recovery', () => {
    const { onEditHost } = renderPanel({
      status: 'failed',
      error: { code: 'SSH_CONNECTION_REFUSED', detail: 'Connection refused (os error 111)' }
    })
    expect(
      screen.getByRole('heading', { name: 'web.example:2222 refused the connection' })
    ).toBeInTheDocument()
    expect(screen.getByText(/SSH_CONNECTION_REFUSED: Connection refused/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit host' }))
    expect(onEditHost).toHaveBeenCalledWith(profile)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(sessions.retrySSHSession).toHaveBeenCalledWith('tab')
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(sessions.closeSSHSession).toHaveBeenCalledWith('tab')
  })

  it('does not offer Edit host when the fix is elsewhere', () => {
    renderPanel({ status: 'failed', error: { code: 'SSH_TIMEOUT', detail: 'timed out' } })
    expect(screen.queryByRole('button', { name: 'Edit host' })).toBeNull()
  })
})
