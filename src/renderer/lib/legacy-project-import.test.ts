import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store, tauri, hostImport, writeFailures, events } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  tauri: { value: true },
  hostImport: vi.fn(),
  writeFailures: new Set<string>(),
  /** What touched the host or the store, in order. */
  events: [] as string[]
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(async (key: string) =>
      store.has(key)
        ? { success: true, data: store.get(key) }
        : { success: false, code: 'KEY_NOT_FOUND', error: `Key not found: ${key}` }
    ),
    write: vi.fn(async (key: string, data: unknown) => {
      events.push(`write:${key}`)
      if (writeFailures.has(key)) return { success: false, code: 'WRITE_ERROR', error: 'disk full' }
      store.set(key, data)
      return { success: true, data: undefined }
    }),
    delete: vi.fn(async (key: string) => {
      events.push(`delete:${key}`)
      store.delete(key)
      return { success: true, data: undefined }
    })
  }
}))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => tauri.value }))
vi.mock('@/lib/tauri-remote-api', () => ({ projectRegistryImport: hostImport }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

import { persistenceApi } from '@/lib/api'
import { importLegacyProjects, LEGACY_PROJECTS_KEY } from './legacy-project-import'

const LEGACY_RECORD = {
  projects: [
    {
      id: 'p1',
      name: 'Alpha',
      color: 'blue',
      path: '/work/alpha',
      isArchived: false,
      isDefault: true,
      gitBranch: 'main',
      defaultShell: '/bin/zsh',
      envVars: [
        { key: 'PORT', value: '3000' },
        { key: 'TOKEN', value: '[REDACTED]', isSecret: true }
      ],
      worktrees: [{ id: 'w1', name: 'w1', branch: 'x', path: '/work/alpha-w1', createdAt: 't' }],
      isGitRepo: true,
      icon: { dataUri: 'data:image/png;base64,AA==', fetchedAt: 5 }
    },
    { id: 'p2', name: 'Beta', color: 'red', isArchived: true }
  ],
  groups: [{ id: 'g1', name: 'Group', projectIds: ['p1'] }],
  activeProjectId: 'p2',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

beforeEach(() => {
  vi.clearAllMocks()
  store.clear()
  writeFailures.clear()
  events.length = 0
  tauri.value = true
  hostImport.mockImplementation(async () => {
    events.push('host')
    return { success: true, data: { imported: true } }
  })
})

describe('importLegacyProjects', () => {
  it('never runs on the web: no read, no host call', async () => {
    tauri.value = false
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)

    expect(await importLegacyProjects()).toBe('skipped')

    expect(persistenceApi.read).not.toHaveBeenCalled()
    expect(hostImport).not.toHaveBeenCalled()
    expect(store.has(LEGACY_PROJECTS_KEY)).toBe(true)
  })

  it('skips without a host call when the old record is absent', async () => {
    expect(await importLegacyProjects()).toBe('skipped')

    expect(hostImport).not.toHaveBeenCalled()
    expect(persistenceApi.write).not.toHaveBeenCalled()
  })

  it('sends the list and the default to the host, keeps the rest as prefs, then deletes the old key', async () => {
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)

    expect(await importLegacyProjects()).toBe('imported')

    expect(hostImport).toHaveBeenCalledTimes(1)
    expect(hostImport).toHaveBeenCalledWith(
      [
        {
          id: 'p1',
          name: 'Alpha',
          color: 'blue',
          path: '/work/alpha',
          isArchived: false,
          isDefault: true
        },
        { id: 'p2', name: 'Beta', color: 'red', path: null, isArchived: true, isDefault: false }
      ],
      'p1'
    )
    const prefs = store.get('project-prefs') as {
      projects: Record<string, unknown>
      groups: unknown[]
      order: string[]
    }
    expect(prefs.projects.p1).toEqual({
      gitBranch: 'main',
      defaultShell: '/bin/zsh',
      envVars: LEGACY_RECORD.projects[0].envVars,
      worktrees: LEGACY_RECORD.projects[0].worktrees,
      isGitRepo: true,
      icon: LEGACY_RECORD.projects[0].icon
    })
    expect(prefs.groups).toEqual(LEGACY_RECORD.groups)
    expect(prefs.order).toEqual(['p1', 'p2'])
    expect(store.has(LEGACY_PROJECTS_KEY)).toBe(false)
  })

  it('never sends env var values to the host', async () => {
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)

    await importLegacyProjects()

    expect(JSON.stringify(hostImport.mock.calls)).not.toContain('PORT')
    expect(JSON.stringify(hostImport.mock.calls)).not.toContain('REDACTED')
  })

  it('carries the old active project over to the device key unless the device already has one', async () => {
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)
    await importLegacyProjects()
    expect(store.get('active-project')).toBe('p2')

    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)
    store.set('active-project', 'p1')
    await importLegacyProjects()
    expect(store.get('active-project')).toBe('p1')
  })

  it('imports once: the second launch finds no old record and never calls the host again', async () => {
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)

    await importLegacyProjects()
    expect(await importLegacyProjects()).toBe('skipped')

    expect(hostImport).toHaveBeenCalledTimes(1)
  })

  it('deletes the old key only after the host acknowledged and the prefs are saved', async () => {
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)

    await importLegacyProjects(async () => {
      events.push('beforeDelete')
    })

    expect(events).toEqual([
      'host',
      'write:project-prefs',
      'write:active-project',
      'beforeDelete',
      'delete:projects'
    ])
  })

  it('keeps the old record for the next launch when the host does not acknowledge', async () => {
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)
    hostImport.mockResolvedValue({ success: false, code: 'INVOKE_ERROR', error: 'host down' })

    expect(await importLegacyProjects()).toBe('failed')

    expect(store.has(LEGACY_PROJECTS_KEY)).toBe(true)
    expect(store.has('project-prefs')).toBe(false)
  })

  it('keeps the old record when the prefs cannot be saved', async () => {
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)
    writeFailures.add('project-prefs')

    expect(await importLegacyProjects()).toBe('failed')

    expect(store.has(LEGACY_PROJECTS_KEY)).toBe(true)
  })

  it('still splits the prefs and deletes the key when the host had already imported', async () => {
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)
    hostImport.mockResolvedValue({ success: true, data: { imported: false } })

    expect(await importLegacyProjects()).toBe('imported')

    expect(store.has('project-prefs')).toBe(true)
    expect(store.has(LEGACY_PROJECTS_KEY)).toBe(false)
  })

  it('never overwrites prefs the device already saved', async () => {
    store.set(LEGACY_PROJECTS_KEY, LEGACY_RECORD)
    store.set('project-prefs', {
      projects: { p1: { gitBranch: 'kept' } },
      groups: [{ id: 'mine', name: 'Mine', projectIds: [] }],
      order: ['p2', 'p1'],
      updatedAt: 't'
    })

    await importLegacyProjects()

    const prefs = store.get('project-prefs') as {
      projects: Record<string, { gitBranch?: string }>
      groups: Array<{ id: string }>
      order: string[]
    }
    expect(prefs.projects.p1.gitBranch).toBe('kept')
    expect(prefs.groups.map((g) => g.id)).toEqual(['mine'])
    expect(prefs.order).toEqual(['p2', 'p1'])
  })

  it('imports an empty old list so the host still marks itself imported', async () => {
    store.set(LEGACY_PROJECTS_KEY, { projects: [], activeProjectId: '' })

    expect(await importLegacyProjects()).toBe('imported')

    expect(hostImport).toHaveBeenCalledWith([], null)
    expect(store.has(LEGACY_PROJECTS_KEY)).toBe(false)
  })
})
