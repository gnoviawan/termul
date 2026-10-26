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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { canUseHostSsh, createSSHApi } from '../ssh-api'

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
      conflictHandled: true
    })
  })

  it('saveProfile and deleteProfile assert the exact list they read', async () => {
    const api = createSSHApi()
    const stored = [profile({ id: 'keep' }), profile({ id: 'drop' })]
    mockPersistenceApi.read.mockResolvedValue({ success: true, data: stored })

    await api.saveProfile(profile({ id: 'new' }))
    await api.deleteProfile('drop')

    expect(mockPersistenceApi.write.mock.calls.map((c) => c[2])).toEqual([
      { expected: stored, conflictHandled: true },
      { expected: stored, conflictHandled: true }
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
      { expected: first, conflictHandled: true },
      { expected: second, conflictHandled: true }
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
    expect(mockPersistenceApi.write.mock.calls.map((c) => c[2].conflictHandled)).toEqual([
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
    mockPersistenceApi.read.mockResolvedValue({
      success: false,
      error: 'not found',
      code: 'KEY_NOT_FOUND'
    })
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
    const writtenKeys = mockPersistenceApi.write.mock.calls.map((c) => c[0])
    expect(writtenKeys).toEqual(['ssh/profiles-migrated'])
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

  it('reports SSH usable only once the grant is hostLocal', () => {
    expect(canUseHostSsh()).toBe(true)
    transport.connectionCapabilities.mockReturnValue({ write: true, hostLocal: false })
    expect(canUseHostSsh()).toBe(false)
    transport.connectionCapabilities.mockReturnValue(null)
    expect(canUseHostSsh()).toBe(false)
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

/**
 * The one-time copy of the web store's profiles to the host, against an
 * in-memory compare-and-set store and an in-memory host profile file. A
 * "browser" is the same api on a connection without the hostLocal grant.
 */
describe('sshApi profile copy to the host', () => {
  const p1 = profile()
  const p2 = profile({ id: 'p-2', name: 'staging' })
  const p3 = profile({ id: 'p-3', name: 'added-in-browser' })

  let store: Map<string, unknown>
  let host: Map<string, SSHProfile>
  let beforeStoreWrite: ((key: string) => void) | undefined
  let hostSaveFailsAt: number
  let hostSaves: number
  /** What the persistence layer would put on its error bus (the user's toast). */
  let reported: string[]

  const asBrowser = () =>
    transport.connectionCapabilities.mockReturnValue({ write: true, hostLocal: false })
  const asGpuix = () =>
    transport.connectionCapabilities.mockReturnValue({ write: true, hostLocal: true })
  const ids = (list: SSHProfile[] | undefined) => (list ?? []).map((p) => p.id)
  const hostIds = () => [...host.keys()]

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    transport.connect.mockResolvedValue(undefined)
    asGpuix()
    store = new Map()
    host = new Map([[p1.id, p1]])
    beforeStoreWrite = undefined
    hostSaveFailsAt = Number.POSITIVE_INFINITY
    hostSaves = 0
    reported = []
    mockPersistenceApi.read.mockImplementation(async (key: string) =>
      store.has(key)
        ? { success: true, data: structuredClone(store.get(key)) }
        : { success: false, error: `Key not found: ${key}`, code: 'KEY_NOT_FOUND' }
    )
    mockPersistenceApi.write.mockImplementation(
      async (
        key: string,
        data: unknown,
        opts?: { expected?: unknown; conflictHandled?: boolean }
      ) => {
        beforeStoreWrite?.(key)
        const current = store.has(key) ? store.get(key) : null
        if (opts && 'expected' in opts) {
          if (JSON.stringify(opts.expected ?? null) !== JSON.stringify(current)) {
            if (!opts.conflictHandled) reported.push(`${key}: STORE_CAS_FAILED`)
            return { success: false, error: 'changed', code: 'STORE_CAS_FAILED' }
          }
        }
        store.set(key, structuredClone(data))
        return { success: true, data: undefined }
      }
    )
    transport.sshRequest.mockImplementation(
      async (command: string, args?: { profile?: SSHProfile }) => {
        if (command === 'ssh_list_profiles') return [...host.values()]
        if (command === 'ssh_save_profile' && args?.profile) {
          if (hostSaves >= hostSaveFailsAt) {
            throw Object.assign(new Error('host went away'), { code: 'SSH_PROFILE_ERROR' })
          }
          hostSaves++
          host.set(args.profile.id, args.profile)
          return null
        }
        throw new Error(`unexpected ${command}`)
      }
    )
  })

  afterEach(() => {
    mockPersistenceApi.read.mockReset()
    mockPersistenceApi.write.mockReset()
    transport.sshRequest.mockReset()
  })

  it('copies the stored profiles the host lacks once and leaves the store whole', async () => {
    store.set('ssh/profiles', [p1, p2])
    const api = createSSHApi()

    const first = await api.listProfiles()

    expect(ids(first.success ? first.data : undefined)).toEqual(['p-1', 'p-2'])
    expect(hostIds()).toEqual(['p-1', 'p-2'])
    expect(store.get('ssh/profiles')).toEqual([p1, p2])
    expect(store.get('ssh/profiles-migrated')).toMatchObject({ count: 1 })

    host.delete('p-2')
    const second = await api.listProfiles()
    expect(ids(second.success ? second.data : undefined)).toEqual(['p-1'])
    expect(hostIds()).toEqual(['p-1'])
  })

  it('leaves the browser list unchanged, and later browser saves stay in the browser', async () => {
    store.set('ssh/profiles', [p1, p2])
    const api = createSSHApi()
    await api.listProfiles()

    asBrowser()
    const browserList = await api.listProfiles()
    expect(ids(browserList.success ? browserList.data : undefined)).toEqual(['p-1', 'p-2'])
    expect((await api.saveProfile(p3)).success).toBe(true)

    asGpuix()
    await api.listProfiles()
    expect(hostIds()).toEqual(['p-1', 'p-2'])

    asBrowser()
    const after = await api.listProfiles()
    expect(ids(after.success ? after.data : undefined)).toEqual(['p-1', 'p-2', 'p-3'])
  })

  it('keeps a browser write that lands during the copy', async () => {
    store.set('ssh/profiles', [p1, p2])
    beforeStoreWrite = (key) => {
      if (key !== 'ssh/profiles-migrated') return
      beforeStoreWrite = undefined
      store.set('ssh/profiles', [p1, { ...p2, name: 'renamed-in-browser' }, p3])
    }
    const api = createSSHApi()

    await api.listProfiles()

    expect(store.get('ssh/profiles')).toEqual([p1, { ...p2, name: 'renamed-in-browser' }, p3])
    expect(hostIds()).toEqual(['p-1', 'p-2'])
    expect(store.has('ssh/profiles-migrated')).toBe(true)
  })

  it('lets two host-local clients copy at once without duplicating a profile', async () => {
    store.set('ssh/profiles', [p1, p2, p3])
    const [a, b] = [createSSHApi(), createSSHApi()]

    const [ra, rb] = await Promise.all([a.listProfiles(), b.listProfiles()])

    expect(ids(ra.success ? ra.data : undefined)).toEqual(['p-1', 'p-2', 'p-3'])
    expect(ids(rb.success ? rb.data : undefined)).toEqual(['p-1', 'p-2', 'p-3'])
    expect(hostIds()).toEqual(['p-1', 'p-2', 'p-3'])
    const markerWrites = mockPersistenceApi.write.mock.calls.filter(
      (c) => c[0] === 'ssh/profiles-migrated'
    )
    expect(markerWrites).toHaveLength(2)
    expect(store.get('ssh/profiles')).toEqual([p1, p2, p3])
    expect(reported).toEqual([])
  })

  it('copies once, quietly, when one client lists twice at once', async () => {
    store.set('ssh/profiles', [p1, p2, p3])
    const api = createSSHApi()

    const [panel, workspace] = await Promise.all([api.listProfiles(), api.listProfiles()])

    expect(ids(panel.success ? panel.data : undefined)).toEqual(['p-1', 'p-2', 'p-3'])
    expect(ids(workspace.success ? workspace.data : undefined)).toEqual(['p-1', 'p-2', 'p-3'])
    expect(hostSaves).toBe(2)
    const markerWrites = mockPersistenceApi.write.mock.calls.filter(
      (c) => c[0] === 'ssh/profiles-migrated'
    )
    expect(markerWrites).toHaveLength(1)
    expect(reported).toEqual([])
  })

  it('resumes a copy that stopped midway at the next list', async () => {
    store.set('ssh/profiles', [p1, p2, p3])
    hostSaveFailsAt = 1
    const api = createSSHApi()

    const interrupted = await api.listProfiles()
    expect(ids(interrupted.success ? interrupted.data : undefined)).toEqual(['p-1', 'p-2'])
    expect(store.has('ssh/profiles-migrated')).toBe(false)

    hostSaveFailsAt = Number.POSITIVE_INFINITY
    const resumed = await api.listProfiles()
    expect(ids(resumed.success ? resumed.data : undefined)).toEqual(['p-1', 'p-2', 'p-3'])
    expect(store.get('ssh/profiles-migrated')).toMatchObject({ count: 1 })
    expect(store.get('ssh/profiles')).toEqual([p1, p2, p3])
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
    mockPersistenceApi.read.mockResolvedValue({ success: true, data: { copiedAt: 'x', count: 0 } })
    for (const call of calls(createSSHApi())) await call()
    const web = transport.sshRequest.mock.calls.map(([command, args]) => [command, args])

    expect(desktop).toHaveLength(22)
    expect(web).toEqual(desktop)
  })
})
