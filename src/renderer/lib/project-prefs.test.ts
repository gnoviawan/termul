import type { ProjectPrefsRecord } from '@shared/types/persistence.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { persistence, secrets, tauri, mockApi } = vi.hoisted(() => {
  const persistence = {
    record: null as ProjectPrefsRecord | null,
    readCode: 'KEY_NOT_FOUND' as string,
    written: [] as ProjectPrefsRecord[]
  }
  const secrets = new Map<string, string>()
  const tauri = { value: true }
  const mockApi = {
    persistenceApi: {
      read: vi.fn(async () =>
        persistence.record
          ? { success: true, data: persistence.record }
          : { success: false, code: persistence.readCode, error: 'none' }
      ),
      writeDebounced: vi.fn(async (_key: string, data: ProjectPrefsRecord) => {
        persistence.written.push(data)
        return { success: true, data: undefined }
      })
    },
    secureStorageApi: {
      getSecret: vi.fn(async (key: string) =>
        secrets.has(key)
          ? { success: true, data: secrets.get(key) }
          : { success: false, error: 'not found' }
      ),
      setSecret: vi.fn(async (key: string, value: string) => {
        secrets.set(key, value)
        return { success: true, data: undefined }
      }),
      deleteSecret: vi.fn(async (key: string) => {
        secrets.delete(key)
        return { success: true, data: undefined }
      })
    }
  }
  return { persistence, secrets, tauri, mockApi }
})

vi.mock('@/lib/api', () => mockApi)
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => tauri.value }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

import type { Project } from '@/types/project'
import {
  _resetProjectPrefsForTests,
  forgetProjectPrefs,
  getProjectLayout,
  getProjectPrefs,
  loadProjectPrefs,
  persistProjectPrefs,
  rememberProjectPrefs
} from './project-prefs'

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: `Project ${id}`, color: 'blue', path: `/work/${id}`, ...extra }
}

function lastRecord(): ProjectPrefsRecord {
  return persistence.written[persistence.written.length - 1]
}

beforeEach(() => {
  vi.clearAllMocks()
  persistence.record = null
  persistence.readCode = 'KEY_NOT_FOUND'
  persistence.written = []
  secrets.clear()
  tauri.value = true
  _resetProjectPrefsForTests()
})

describe('persistProjectPrefs', () => {
  it('keeps client-only fields and the layout, and nothing the host owns', async () => {
    const icon = { dataUri: 'data:image/png;base64,AA==', fetchedAt: 9 } as never
    const worktree = {
      id: 'w',
      name: 'w',
      branch: 'x',
      path: '/work/a-w',
      createdAt: 't',
      outsideProjectRoot: true
    }
    const groups = [{ id: 'g', name: 'G', projectIds: ['a'] }]

    await persistProjectPrefs(
      [
        project('a', {
          gitBranch: 'main',
          defaultShell: '/bin/zsh',
          isGitRepo: true,
          icon,
          worktrees: [worktree],
          symlinkDirs: ['dist']
        }),
        project('b')
      ],
      groups,
      []
    )

    const record = lastRecord()
    expect(record.projects.a).toEqual({
      gitBranch: 'main',
      defaultShell: '/bin/zsh',
      isGitRepo: true,
      icon,
      // `outsideProjectRoot` is derived, never saved.
      worktrees: [{ id: 'w', name: 'w', branch: 'x', path: '/work/a-w', createdAt: 't' }],
      symlinkDirs: ['dist']
    })
    expect(record.projects.b).toEqual({})
    expect(record.groups).toEqual(groups)
    expect(record.order).toEqual(['a', 'b'])
  })

  it('stores secret env values in secure storage and writes only the placeholder', async () => {
    const envVars = [
      { key: 'PORT', value: '3000' },
      { key: 'TOKEN', value: 'hunter2', isSecret: true }
    ]

    await persistProjectPrefs([project('a', { envVars })], [], [])

    expect(secrets.get('project:a:env:TOKEN')).toBe('hunter2')
    expect(lastRecord().projects.a.envVars).toEqual([
      { key: 'PORT', value: '3000' },
      { key: 'TOKEN', value: '[REDACTED]', isSecret: true }
    ])
    expect(JSON.stringify(lastRecord())).not.toContain('hunter2')
  })

  it('does not overwrite secure storage for a secret that is still the placeholder', async () => {
    secrets.set('project:a:env:TOKEN', 'kept')

    await persistProjectPrefs(
      [project('a', { envVars: [{ key: 'TOKEN', value: '[REDACTED]', isSecret: true }] })],
      [],
      []
    )

    expect(mockApi.secureStorageApi.setSecret).not.toHaveBeenCalled()
    expect(secrets.get('project:a:env:TOKEN')).toBe('kept')
  })

  it('aborts without writing when secure storage refuses a secret', async () => {
    mockApi.secureStorageApi.setSecret.mockResolvedValueOnce({
      success: false,
      error: 'locked'
    } as never)

    await expect(
      persistProjectPrefs(
        [project('a', { envVars: [{ key: 'TOKEN', value: 'hunter2', isSecret: true }] })],
        [],
        []
      )
    ).rejects.toThrow('Failed to store secret TOKEN for project a: locked')

    expect(persistence.written).toEqual([])
  })

  it('removes the secure-storage entry of a secret that was renamed or made plain', async () => {
    secrets.set('project:a:env:OLD', 'x')
    secrets.set('project:a:env:PLAIN', 'y')
    const before = project('a', {
      envVars: [
        { key: 'OLD', value: 'x', isSecret: true },
        { key: 'PLAIN', value: 'y', isSecret: true }
      ]
    })
    const after = project('a', {
      envVars: [
        { key: 'NEW', value: 'z', isSecret: true },
        { key: 'PLAIN', value: 'y' }
      ]
    })

    await persistProjectPrefs([after], [], [before])

    expect(secrets.has('project:a:env:OLD')).toBe(false)
    expect(secrets.has('project:a:env:PLAIN')).toBe(false)
    expect(secrets.get('project:a:env:NEW')).toBe('z')
  })

  it('does not persist env vars on the web, where there is no secure storage', async () => {
    tauri.value = false

    await persistProjectPrefs(
      [
        project('a', {
          envVars: [{ key: 'TOKEN', value: 'hunter2', isSecret: true }],
          gitBranch: 'main'
        })
      ],
      [],
      []
    )

    expect(lastRecord().projects.a).toEqual({ gitBranch: 'main' })
    expect(mockApi.secureStorageApi.setSecret).not.toHaveBeenCalled()
  })

  it('writes once for a burst of identical states and again after a real change', async () => {
    const projects = [project('a', { gitBranch: 'main' })]

    await persistProjectPrefs(projects, [], [])
    await persistProjectPrefs(
      projects.map((p) => ({ ...p })),
      [],
      projects
    )
    expect(persistence.written).toHaveLength(1)

    await persistProjectPrefs([project('a', { gitBranch: 'dev' })], [], projects)
    expect(persistence.written).toHaveLength(2)
    expect(lastRecord().projects.a.gitBranch).toBe('dev')
  })

  it('keeps the prefs of a project the list does not carry any more', async () => {
    await persistProjectPrefs(
      [project('a', { gitBranch: 'a1' }), project('b', { gitBranch: 'b1' })],
      [],
      []
    )

    await persistProjectPrefs([project('a', { gitBranch: 'a1' })], [], [])

    expect(Object.keys(lastRecord().projects).sort()).toEqual(['a', 'b'])
    expect(lastRecord().order).toEqual(['a', 'b'])
  })

  it('retries the same state after a failed write', async () => {
    mockApi.persistenceApi.writeDebounced.mockResolvedValueOnce({
      success: false,
      error: 'disk full'
    } as never)
    const projects = [project('a')]

    await expect(persistProjectPrefs(projects, [], [])).rejects.toThrow('disk full')
    await persistProjectPrefs(projects, [], [])

    expect(persistence.written).toHaveLength(1)
  })
})

describe('loadProjectPrefs', () => {
  it('reads the record and resolves secrets from secure storage', async () => {
    secrets.set('project:a:env:TOKEN', 'hunter2')
    persistence.record = {
      projects: {
        a: {
          gitBranch: 'main',
          envVars: [
            { key: 'PORT', value: '3000' },
            { key: 'TOKEN', value: '[REDACTED]', isSecret: true }
          ]
        }
      },
      groups: [{ id: 'g', name: 'G', projectIds: ['a'] }],
      order: ['b', 'a'],
      updatedAt: 't'
    }

    expect(await loadProjectPrefs()).toBe(true)

    expect(getProjectPrefs('a')).toEqual({
      gitBranch: 'main',
      envVars: [
        { key: 'PORT', value: '3000' },
        { key: 'TOKEN', value: 'hunter2', isSecret: true }
      ]
    })
    expect(getProjectLayout().order).toEqual(['b', 'a'])
    expect(getProjectLayout().groups[0].name).toBe('G')
  })

  it('keeps the placeholder when the secret cannot be read', async () => {
    persistence.record = {
      projects: { a: { envVars: [{ key: 'TOKEN', value: '[REDACTED]', isSecret: true }] } },
      groups: [],
      order: [],
      updatedAt: 't'
    }

    await loadProjectPrefs()

    expect(getProjectPrefs('a')?.envVars).toEqual([
      { key: 'TOKEN', value: '[REDACTED]', isSecret: true }
    ])
  })

  it('round-trips a resolved icon', async () => {
    const icon = { dataUri: 'data:image/png;base64,AA==', fetchedAt: 42 } as never
    await persistProjectPrefs([project('a', { icon })], [], [])
    persistence.record = lastRecord()

    await loadProjectPrefs()

    expect(getProjectPrefs('a')?.icon).toEqual(icon)
  })

  it('treats an absent record as empty and an unreadable one as not safe to save over', async () => {
    expect(await loadProjectPrefs()).toBe(true)
    expect(getProjectPrefs('a')).toBeUndefined()

    persistence.readCode = 'READ_ERROR'
    expect(await loadProjectPrefs()).toBe(false)
  })
})

describe('rememberProjectPrefs / forgetProjectPrefs', () => {
  it('remembers prefs for a project that is not in the store yet', () => {
    rememberProjectPrefs('new', { defaultShell: '/bin/zsh' })

    expect(getProjectPrefs('new')).toEqual({ defaultShell: '/bin/zsh' })
  })

  it('forgets a deleted project and deletes its secrets', async () => {
    await persistProjectPrefs(
      [project('a', { envVars: [{ key: 'TOKEN', value: 'hunter2', isSecret: true }] })],
      [{ id: 'g', name: 'G', projectIds: ['a', 'b'] }],
      []
    )

    await forgetProjectPrefs('a')

    expect(getProjectPrefs('a')).toBeUndefined()
    expect(secrets.has('project:a:env:TOKEN')).toBe(false)
    expect(getProjectLayout().groups[0].projectIds).toEqual(['b'])
  })

  it('can forget prefs that were never saved without touching secure storage', async () => {
    rememberProjectPrefs('new', { envVars: [{ key: 'TOKEN', value: 'x', isSecret: true }] })

    await forgetProjectPrefs('new', { keepSecrets: true })

    expect(getProjectPrefs('new')).toBeUndefined()
    expect(mockApi.secureStorageApi.deleteSecret).not.toHaveBeenCalled()
  })
})
