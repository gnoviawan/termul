import type { SSHKeyFileInfo, SSHProfile } from '@shared/types/ssh.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSSHStore } from '@/stores/ssh-store'
import { SSHHostEditor } from './SSHHostEditor'

const { sshApi, dialogApi } = vi.hoisted(() => ({
  sshApi: {
    saveProfile: vi.fn(async () => ({ success: true as const, data: undefined })),
    listKeys: vi.fn(async () => ({ success: true as const, data: [] as SSHKeyFileInfo[] })),
    inspectKey: vi.fn()
  },
  dialogApi: { selectFile: vi.fn() }
}))

vi.mock('@/lib/api', () => ({ sshApi, dialogApi }))
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriContext: () => true
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const existing: SSHProfile = {
  id: 'p1',
  name: 'Web',
  host: 'web.example',
  port: 2222,
  username: 'deploy',
  authMethod: 'password',
  portForwards: [],
  group: 'Production',
  tags: ['prod'],
  hasStoredPassword: true
}

function renderEditor(profile: SSHProfile | null = null) {
  const onSaved = vi.fn()
  const onOpenChange = vi.fn()
  render(<SSHHostEditor open profile={profile} onOpenChange={onOpenChange} onSaved={onSaved} />)
  return { onSaved, onOpenChange }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSSHStore.setState({ profiles: [existing] })
})

describe('new host', () => {
  it('validates inline and focuses the first problem instead of saving', async () => {
    const { onSaved } = renderEditor()
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '70000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }))

    expect(await screen.findByText('Enter a hostname or IP address.')).toBeInTheDocument()
    expect(screen.getByText('Use a port from 1 to 65535.')).toBeInTheDocument()
    expect(screen.getByText('Enter the username to sign in with.')).toBeInTheDocument()
    const address = screen.getByLabelText('Address')
    expect(address).toHaveAttribute('aria-invalid', 'true')
    expect(document.activeElement).toBe(address)
    expect(sshApi.saveProfile).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('splits a pasted user@host:port and saves, then connects', async () => {
    const { onSaved } = renderEditor()
    const address = screen.getByLabelText('Address')
    fireEvent.change(address, { target: { value: 'admin@db.internal:2200' } })
    fireEvent.blur(address)
    expect(screen.getByLabelText('Address')).toHaveValue('db.internal')
    expect(screen.getByLabelText('Username')).toHaveValue('admin')
    expect(screen.getByLabelText('Port')).toHaveValue('2200')

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'Databases' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [saved, connect] = onSaved.mock.calls[0]
    expect(connect).toBe(true)
    expect(saved).toMatchObject({
      name: 'db.internal',
      host: 'db.internal',
      port: 2200,
      username: 'admin',
      group: 'Databases'
    })
    // The secret goes to the backend (keychain) but never back to the caller.
    expect(sshApi.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw' }))
    expect(saved.password).toBeUndefined()
    expect(useSSHStore.getState().profiles.find((p) => p.host === 'db.internal')).toMatchObject({
      hasStoredPassword: true,
      password: undefined
    })
  })

  it('"Save" adds the host without connecting', async () => {
    const { onSaved } = renderEditor()
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'h.example' } })
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'u' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onSaved.mock.calls[0][1]).toBe(false)
  })
})

describe('existing host', () => {
  it('prefills fields but never the stored password', () => {
    renderEditor(existing)
    expect(screen.getByRole('heading', { name: 'Edit host' })).toBeInTheDocument()
    expect(screen.getByLabelText('Address')).toHaveValue('web.example')
    expect(screen.getByLabelText('Tags')).toHaveValue('prod')
    const password = screen.getByLabelText('Password')
    expect(password).toHaveValue('')
    expect(password).toHaveAttribute('placeholder', 'Saved — type to replace')
    expect(
      screen.getByText('Saved in your system keychain. Leave empty to keep it.')
    ).toBeInTheDocument()
  })

  it('keeps the stored password when the field stays empty', async () => {
    const { onSaved } = renderEditor(existing)
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Web 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const sent = sshApi.saveProfile.mock.calls[0][0] as SSHProfile
    expect(sent).toMatchObject({ id: 'p1', name: 'Web 1', hasStoredPassword: true })
    expect(sent.password).toBeUndefined()
  })
})

describe('private keys', () => {
  it('offers keys from ~/.ssh and explains an encrypted key', async () => {
    const key: SSHKeyFileInfo = {
      path: 'C:/Users/u/.ssh/id_ed25519',
      status: 'ok',
      encrypted: true,
      keyType: 'ssh-ed25519'
    }
    sshApi.listKeys.mockResolvedValue({ success: true, data: [key] })
    sshApi.inspectKey.mockResolvedValue({ success: true, data: key })
    renderEditor({
      ...existing,
      authMethod: 'key',
      privateKeyPath: key.path,
      hasStoredPassword: false
    })

    expect(await screen.findByText('ssh-ed25519, protected by a passphrase.')).toBeInTheDocument()
    expect(screen.getByLabelText('Key passphrase')).toBeInTheDocument()
    expect(sshApi.listKeys).toHaveBeenCalled()
  })

  it('points out a public key picked by mistake', async () => {
    sshApi.inspectKey.mockResolvedValue({
      success: true,
      data: { path: '/k/id_ed25519.pub', status: 'notPrivateKey', encrypted: false, keyType: null }
    })
    renderEditor({ ...existing, authMethod: 'key', privateKeyPath: '/k/id_ed25519.pub' })
    expect(
      await screen.findByText('This is the public key. Choose the matching file without .pub.')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Private key')).toHaveAttribute('aria-invalid', 'true')
  })
})
