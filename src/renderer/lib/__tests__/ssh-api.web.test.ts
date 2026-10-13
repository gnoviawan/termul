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

const { mockIsTauriContext, mockInvoke, mockListen, mockPersistenceApi } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
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
  listen: mockListen
}))

vi.mock('../persistence-api', () => ({
  persistenceApi: mockPersistenceApi
}))

import type { SSHProfile } from '@shared/types/ssh.types'
import { createSSHApi } from '../ssh-api'

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

  it('saveProfile asserts the key is absent (expected null) on the first write', async () => {
    const api = createSSHApi()
    mockPersistenceApi.read.mockResolvedValue({
      success: false,
      error: 'Key not found: ssh/profiles',
      code: 'KEY_NOT_FOUND'
    })

    await api.saveProfile(profile())

    expect(mockPersistenceApi.write).toHaveBeenCalledWith('ssh/profiles', [expect.anything()], {
      expected: null,
      retrying: true
    })
  })

  it('saveProfile and deleteProfile assert the exact list they read', async () => {
    const api = createSSHApi()
    const stored = [profile({ id: 'keep' }), profile({ id: 'drop' })]
    mockPersistenceApi.read.mockResolvedValue({ success: true, data: stored })

    await api.saveProfile(profile({ id: 'new' }))
    await api.deleteProfile('drop')

    expect(mockPersistenceApi.write.mock.calls.map((c) => c[2])).toEqual([
      { expected: stored, retrying: true },
      { expected: stored, retrying: true }
    ])
  })

  it('saveProfile re-reads and retries when another device won the compare-and-set', async () => {
    const api = createSSHApi()
    const first = [profile({ id: 'a' })]
    const second = [profile({ id: 'a' }), profile({ id: 'b' })]
    mockPersistenceApi.read
      .mockResolvedValueOnce({ success: true, data: first })
      .mockResolvedValueOnce({ success: true, data: second })
    mockPersistenceApi.write
      .mockResolvedValueOnce({ success: false, error: 'stale', code: 'STORE_CAS_FAILED' })
      .mockResolvedValueOnce({ success: true, data: undefined })

    const result = await api.saveProfile(profile({ id: 'c' }))

    expect(result.success).toBe(true)
    expect(mockPersistenceApi.write.mock.calls.map((c) => c[2])).toEqual([
      { expected: first, retrying: true },
      { expected: second, retrying: true }
    ])
    expect((mockPersistenceApi.write.mock.calls[1][1] as SSHProfile[]).map((p) => p.id)).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('saveProfile gives up with STORE_CAS_FAILED after five lost races and surfaces other errors at once', async () => {
    const api = createSSHApi()
    mockPersistenceApi.read.mockResolvedValue({ success: true, data: [] })
    mockPersistenceApi.write.mockResolvedValue({
      success: false,
      error: 'stale',
      code: 'STORE_CAS_FAILED'
    })
    expect(await api.saveProfile(profile())).toMatchObject({ code: 'STORE_CAS_FAILED' })
    expect(mockPersistenceApi.write).toHaveBeenCalledTimes(5)
    // Only the last lost race is reported to the user.
    expect(mockPersistenceApi.write.mock.calls.map((c) => c[2].retrying)).toEqual([
      true,
      true,
      true,
      true,
      false
    ])

    mockPersistenceApi.write.mockReset()
    mockPersistenceApi.write.mockResolvedValue({
      success: false,
      error: 'down',
      code: 'STORE_UNAVAILABLE'
    })
    expect(await api.saveProfile(profile())).toMatchObject({ code: 'STORE_UNAVAILABLE' })
    expect(mockPersistenceApi.write).toHaveBeenCalledTimes(1)
  })

  it('session commands return WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const api = createSSHApi()
    const results = await Promise.all([
      api.openSession({ sessionId: 's', profileId: 'profile-1', cols: 80, rows: 24 }),
      api.respondHostKey('s', true),
      api.cancelSession('s'),
      api.closeSession('s'),
      api.listSessions(),
      api.inspectKey('/k'),
      api.listKeys(),
      api.duplicateProfile('profile-1'),
      api.sftpRealpath('s', '.')
    ])

    for (const result of results) {
      expect(result.success).toBe(false)
      if (!result.success) expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('session event listeners are no-ops outside the desktop', () => {
    const api = createSSHApi()
    for (const unlisten of [
      api.onSessionProgress(vi.fn()),
      api.onSessionHostKey(vi.fn()),
      api.onSessionEnded(vi.fn())
    ]) {
      expect(unlisten).toBeTypeOf('function')
      unlisten()
    }
    expect(mockListen).not.toHaveBeenCalled()
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
})
