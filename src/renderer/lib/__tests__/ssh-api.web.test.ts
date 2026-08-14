/**
 * Web-branch tests for ssh-api.ts.
 *
 * Pins `isTauriContext()` to FALSE and asserts:
 * - profile CRUD (list/save/delete) reads/writes the server-side store
 *   (issue #613) instead of invoking Tauri commands,
 * - connection/SFTP/askpass methods still return an explicit
 *   `WEB_UNSUPPORTED` result instead of invoking the stubbed
 *   `@tauri-apps/api/core` `invoke()` (which throws `tauriUnavailable` on web).
 * The desktop path is covered by direct invoke assertions in sibling tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockInvoke, mockPersistenceApi } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn(),
  mockPersistenceApi: {
    read: vi.fn(),
    write: vi.fn()
  }
}))

vi.mock('../tauri-runtime', () => ({
  cleanupTauriListener: vi.fn(),
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

vi.mock('../persistence-api', () => ({
  persistenceApi: mockPersistenceApi
}))

import type { SSHProfile } from '@shared/types/ssh.types'
import { createAskpassScript, createSSHApi } from '../ssh-api'

const profile = (overrides: Partial<SSHProfile> = {}): SSHProfile => ({
  id: 'p-1',
  name: 'prod',
  host: 'example.com',
  port: 22,
  username: 'root',
  authMethod: 'key',
  privateKeyPath: '/home/u/.ssh/id_ed25519',
  portForwards: [],
  ...overrides
})

describe('sshApi (web branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    mockInvoke.mockReset()
    mockPersistenceApi.read.mockReset()
    mockPersistenceApi.write.mockReset()
    mockPersistenceApi.write.mockResolvedValue({ success: true, data: undefined })
  })

  it('listProfiles returns stored profiles from the server-side store', async () => {
    const api = createSSHApi()
    mockPersistenceApi.read.mockResolvedValue({ success: true, data: [profile()] })

    const result = await api.listProfiles()

    expect(mockPersistenceApi.read).toHaveBeenCalledWith('ssh/profiles')
    expect(result).toEqual({ success: true, data: [profile()] })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('listProfiles returns an empty list on first run (KEY_NOT_FOUND)', async () => {
    const api = createSSHApi()
    mockPersistenceApi.read.mockResolvedValue({
      success: false,
      error: 'Key not found: ssh/profiles',
      code: 'KEY_NOT_FOUND'
    })

    const result = await api.listProfiles()

    expect(result).toEqual({ success: true, data: [] })
  })

  it('saveProfile upserts into the store and strips secrets', async () => {
    const api = createSSHApi()
    mockPersistenceApi.read.mockResolvedValue({ success: true, data: [] })

    const result = await api.saveProfile(profile({ password: 'secret', passphrase: 'phrase' }))

    expect(result.success).toBe(true)
    const written = mockPersistenceApi.write.mock.calls[0]?.[1] as SSHProfile[]
    expect(written).toHaveLength(1)
    expect(written[0].password).toBeUndefined()
    expect(written[0].passphrase).toBeUndefined()
    expect(written[0].hasStoredPassword).toBe(false)
    expect(written[0].id).toBe('p-1')
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('deleteProfile filters the stored list', async () => {
    const api = createSSHApi()
    mockPersistenceApi.read.mockResolvedValue({
      success: true,
      data: [profile({ id: 'keep' }), profile({ id: 'drop' })]
    })

    const result = await api.deleteProfile('drop')

    expect(result.success).toBe(true)
    const written = mockPersistenceApi.write.mock.calls[0]?.[1] as SSHProfile[]
    expect(written.map((p) => p.id)).toEqual(['keep'])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('connect returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const api = createSSHApi()
    const result = await api.connect('profile-1')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('sftpListDir returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const api = createSSHApi()
    const result = await api.sftpListDir('conn-1', '/remote')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('createAskpassScript returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await createAskpassScript('secret')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
