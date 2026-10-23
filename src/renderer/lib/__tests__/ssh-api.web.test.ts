/**
 * Web-branch tests for ssh-api.ts.
 *
 * Pins `isTauriContext()` to FALSE and asserts:
 * - on a connection the host does not run SSH for, profile CRUD
 *   (list/save/delete) reads/writes the server-side store (issue #613), and
 *   session/SFTP/key methods return an explicit `WEB_UNSUPPORTED` result
 *   instead of invoking the stubbed `@tauri-apps/api/core` `invoke()`,
 * - on a `hostLocal` connection every command, profile CRUD included, runs
 *   over `/ws` under its Tauri name and arguments, and events arrive from the
 *   host's `ssh` watch.
 * The desktop path is covered by direct invoke assertions in sibling tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockInvoke, mockListen, mockPersistenceApi, transport } = vi.hoisted(
  () => ({
    mockIsTauriContext: vi.fn(),
    mockInvoke: vi.fn(),
    mockListen: vi.fn(),
    mockPersistenceApi: {
      read: vi.fn(),
      write: vi.fn()
    },
    transport: {
      connect: vi.fn(),
      connectionCapabilities: vi.fn(),
      sshRequest: vi.fn(),
      watches: { subscribe: vi.fn() }
    }
  })
)

vi.mock('../acp-transport', () => ({
  getAcpTransport: () => transport
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
    transport.connect.mockResolvedValue(undefined)
    transport.connectionCapabilities.mockReturnValue({ write: true, hostLocal: false })
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
    expect(transport.watches.subscribe).not.toHaveBeenCalled()
  })

  it('sftpListDir returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const api = createSSHApi()
    const result = await api.sftpListDir('conn-1', '/remote')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(transport.sshRequest).not.toHaveBeenCalled()
  })
})

describe('sshApi (host-local web connection)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    transport.connect.mockResolvedValue(undefined)
    transport.connectionCapabilities.mockReturnValue({ write: true, hostLocal: true })
    transport.sshRequest.mockResolvedValue(null)
  })

  it('sends each command over /ws under its Tauri name and arguments', async () => {
    const api = createSSHApi()
    await api.openSession({ sessionId: 's', profileId: 'p-1', cols: 80, rows: 24 })
    await api.respondHostKey('s', true)
    await api.sftpListDir('s', '/remote')
    await api.sftpUpload('s', '/tmp/a.txt', '/remote/a.txt')
    await api.duplicateProfile('p-1')
    await api.listKeys()
    expect(transport.sshRequest.mock.calls).toEqual([
      ['ssh_session_open', { request: { sessionId: 's', profileId: 'p-1', cols: 80, rows: 24 } }],
      ['ssh_session_respond_host_key', { sessionId: 's', trust: true }],
      ['sftp_list_dir', { request: { connectionId: 's', remotePath: '/remote' } }],
      [
        'sftp_upload',
        { request: { connectionId: 's', remotePath: '/remote/a.txt', localPath: '/tmp/a.txt' } }
      ],
      ['ssh_duplicate_profile', { profileId: 'p-1' }],
      ['ssh_list_keys', undefined]
    ])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('answers the host value and maps a refusal to its code', async () => {
    const api = createSSHApi()
    transport.sshRequest.mockResolvedValueOnce('/home/deploy')
    expect(await api.sftpRealpath('s', '.')).toEqual({ success: true, data: '/home/deploy' })
    transport.sshRequest.mockRejectedValueOnce(
      Object.assign(new Error('Authentication failed'), { code: 'SSH_AUTH_FAILED' })
    )
    expect(await api.openSession({ sessionId: 's', profileId: 'p', cols: 1, rows: 1 })).toEqual({
      success: false,
      error: 'Authentication failed',
      code: 'SSH_AUTH_FAILED'
    })
  })

  it('keeps profiles with the host SSH, not the server-side store', async () => {
    const api = createSSHApi()
    transport.sshRequest.mockResolvedValueOnce([profile()])
    expect(await api.listProfiles()).toEqual({ success: true, data: [profile()] })
    await api.saveProfile(profile({ password: 'secret' }))
    await api.deleteProfile('p-1')
    expect(transport.sshRequest.mock.calls.map((c) => c[0])).toEqual([
      'ssh_list_profiles',
      'ssh_save_profile',
      'ssh_delete_profile'
    ])
    expect(transport.sshRequest.mock.calls[1][1]).toEqual({
      profile: profile({ password: 'secret' })
    })
    expect(mockPersistenceApi.read).not.toHaveBeenCalled()
    expect(mockPersistenceApi.write).not.toHaveBeenCalled()
  })

  it('waits for the handshake when the grant is not known yet', async () => {
    transport.connectionCapabilities
      .mockReturnValueOnce(null)
      .mockReturnValue({ write: true, hostLocal: true })
    const api = createSSHApi()
    await api.listSessions()
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.sshRequest).toHaveBeenCalledWith('ssh_session_list', undefined)
  })

  it('keeps port forwarding desktop-only', async () => {
    const api = createSSHApi()
    const result = await api.stopPortForward('s', 'f')
    expect(result).toMatchObject({ success: false, code: 'WEB_UNSUPPORTED' })
    expect(transport.sshRequest).not.toHaveBeenCalled()
  })

  it('delivers each ssh watch event to its own listener', async () => {
    const handlers: Array<{ onDelta: (delta: unknown) => void }> = []
    const off = vi.fn()
    transport.watches.subscribe.mockImplementation((_watch, h) => {
      handlers.push(h)
      return off
    })
    const api = createSSHApi()
    const progress = vi.fn()
    const ended = vi.fn()
    const stopProgress = api.onSessionProgress(progress)
    api.onSessionEnded(ended)
    await vi.waitFor(() => expect(handlers).toHaveLength(2))
    expect(transport.watches.subscribe.mock.calls.map((c) => c[0])).toEqual(['ssh', 'ssh'])
    for (const h of handlers) {
      h.onDelta({ event: 'ssh-session-progress', payload: { sessionId: 's', stage: 'auth' } })
    }
    expect(progress).toHaveBeenCalledWith({ sessionId: 's', stage: 'auth' })
    expect(ended).not.toHaveBeenCalled()
    stopProgress()
    expect(off).toHaveBeenCalledTimes(1)
  })
})

describe('sshApi desktop and host-local web parity', () => {
  const calls = (api: ReturnType<typeof createSSHApi>) => [
    () => api.listProfiles(),
    () => api.saveProfile(profile()),
    () => api.deleteProfile('p-1'),
    () => api.duplicateProfile('p-1'),
    () => api.importConfig(),
    () => api.inspectKey('/k'),
    () => api.listKeys(),
    () => api.openSession({ sessionId: 's', profileId: 'p-1', cols: 80, rows: 24, secret: 'x' }),
    () => api.respondHostKey('s', false),
    () => api.cancelSession('s'),
    () => api.closeSession('s'),
    () => api.listSessions(),
    () => api.sftpListDir('s', '/'),
    () => api.sftpRealpath('s', '.'),
    () => api.sftpDownload('s', '/r', '/l'),
    () => api.sftpUpload('s', '/l', '/r'),
    () => api.sftpDelete('s', '/r'),
    () => api.sftpMkdir('s', '/r'),
    () => api.sftpRename('s', '/a', '/b'),
    () => api.sftpReadFile('s', '/r'),
    () => api.sftpWriteFile('s', '/r', 'text'),
    () => api.sftpCreateFile('s', '/r')
  ]

  it('every method sends the same command and arguments on both paths', async () => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValue({ success: true, data: null })
    for (const call of calls(createSSHApi())) await call()
    const desktop = mockInvoke.mock.calls.map(([command, args]) => [command, args])

    mockIsTauriContext.mockReturnValue(false)
    transport.connectionCapabilities.mockReturnValue({ write: true, hostLocal: true })
    transport.sshRequest.mockResolvedValue(null)
    for (const call of calls(createSSHApi())) await call()
    const web = transport.sshRequest.mock.calls.map(([command, args]) => [command, args])

    expect(desktop).toHaveLength(22)
    expect(web).toEqual(desktop)
  })
})
