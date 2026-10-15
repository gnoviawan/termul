import type { ProjectPrefsRecord } from '@shared/types/persistence.types'
import type { ProjectListPayload, ProjectSummary } from '@shared/types/web-projects.types'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const store = new Map<string, unknown>()
  const calls: string[] = []
  return {
    store,
    calls,
    tauri: { value: false },
    subscribe: vi.fn(),
    unwatch: vi.fn(),
    importLegacyProjects: vi.fn(),
    hydrateShellLayout: vi.fn(async () => {}),
    grantFsScope: vi.fn(),
    reconcile: vi.fn(),
    syncMcp: vi.fn(async () => {})
  }
})

vi.mock('@/lib/acp-transport', () => ({
  getAcpTransport: () => ({ watches: { subscribe: h.subscribe } })
}))
vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(async (key: string) =>
      h.store.has(key)
        ? { success: true, data: h.store.get(key) }
        : { success: false, code: 'KEY_NOT_FOUND', error: 'none' }
    ),
    write: vi.fn(async (key: string, data: unknown) => {
      h.store.set(key, data)
      return { success: true, data: undefined }
    }),
    writeDebounced: vi.fn(async (key: string, data: unknown) => {
      h.store.set(key, data)
      return { success: true, data: undefined }
    })
  },
  secureStorageApi: { getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() },
  filesystemApi: { grantFsScope: h.grantFsScope }
}))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => h.tauri.value }))
vi.mock('@/lib/web-auth-gate', () => ({ useWebAuthGateOk: () => true }))
vi.mock('@/lib/legacy-project-import', () => ({
  importLegacyProjects: h.importLegacyProjects,
  LEGACY_PROJECTS_KEY: 'projects'
}))
vi.mock('@/lib/worktree-reconciler', () => ({ reconcileProjectWorktrees: h.reconcile }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/project-registry-api', () => ({
  ProjectBusyError: class extends Error {},
  projectRegistryApi: {}
}))
vi.mock('@/lib/router-navigate', () => ({ clearChatRoute: vi.fn() }))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: { getState: () => ({ syncMcpRegistryToProjectFile: h.syncMcp }) }
}))
vi.mock('@/stores/shell-layout-store', () => ({
  useShellLayoutStore: { getState: () => ({ hydrate: h.hydrateShellLayout }) }
}))

import { persistenceApi } from '@/lib/api'
import { _resetProjectPrefsForTests } from '@/lib/project-prefs'
import { useProjectStore } from '@/stores/project-store'
import { useRemoteStatusStore } from '@/stores/remote-status-store'
import { useProjectRegistry } from './use-project-registry'

function summary(id: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    name: `Project ${id}`,
    color: 'blue',
    path: `/work/${id}`,
    isArchived: false,
    isDefault: false,
    ...extra
  }
}

function list(
  projects: ProjectSummary[],
  defaultProjectId: string | null = null
): ProjectListPayload {
  return { projects, defaultProjectId }
}

/** The handlers the hook registered on the `projects` watch. */
function watchHandlers(): {
  onState: (list: ProjectListPayload) => void
  onDelta: (list: ProjectListPayload) => void
} {
  return h.subscribe.mock.calls[0][1]
}

function mount(): ReturnType<typeof renderHook> {
  return renderHook(() => useProjectRegistry())
}

async function mountAndDeliver(state: ProjectListPayload): Promise<ReturnType<typeof renderHook>> {
  const rendered = mount()
  await waitFor(() => expect(h.subscribe).toHaveBeenCalled())
  act(() => watchHandlers().onState(state))
  await waitFor(() => expect(useProjectStore.getState().isLoaded).toBe(true))
  return rendered
}

beforeEach(() => {
  vi.clearAllMocks()
  h.store.clear()
  h.calls.length = 0
  h.tauri.value = false
  h.subscribe.mockReturnValue(h.unwatch)
  h.importLegacyProjects.mockResolvedValue('skipped')
  h.grantFsScope.mockResolvedValue({ success: true, data: undefined })
  _resetProjectPrefsForTests()
  useProjectStore.setState({ projects: [], groups: [], activeProjectId: '', isLoaded: false })
  useRemoteStatusStore.getState().setStatus(null)
})

describe('useProjectRegistry', () => {
  it('feeds the store from the projects watch and loads it', async () => {
    await mountAndDeliver(list([summary('a'), summary('b', { isDefault: true })], 'b'))

    const state = useProjectStore.getState()
    expect(state.projects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(state.projects[1].isDefault).toBe(true)
    expect(h.subscribe).toHaveBeenCalledWith('projects', expect.any(Object))
  })

  it('replaces the content on every delta, adding and removing projects', async () => {
    await mountAndDeliver(list([summary('a'), summary('b')]))

    act(() => watchHandlers().onDelta(list([summary('b'), summary('c')])))

    await waitFor(() =>
      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['b', 'c'])
    )
  })

  it('never imports on the web', async () => {
    await mountAndDeliver(list([summary('a')]))

    expect(h.importLegacyProjects).not.toHaveBeenCalled()
  })

  it('imports the old desktop record before it watches, and lets the shell layout read it first', async () => {
    h.tauri.value = true
    h.importLegacyProjects.mockImplementation(async (beforeDelete?: () => Promise<void>) => {
      h.calls.push('import')
      await beforeDelete?.()
      return 'imported'
    })
    h.subscribe.mockImplementation(() => {
      h.calls.push('subscribe')
      return h.unwatch
    })

    mount()
    await waitFor(() => expect(h.subscribe).toHaveBeenCalled())

    expect(h.calls).toEqual(['import', 'subscribe'])
    expect(h.hydrateShellLayout).toHaveBeenCalledTimes(1)
  })

  it('still watches the list when the import fails', async () => {
    h.tauri.value = true
    h.importLegacyProjects.mockRejectedValue(new Error('host down'))

    mount()

    await waitFor(() => expect(h.subscribe).toHaveBeenCalled())
  })

  describe('prefs', () => {
    it('carries the saved client-only fields and layout onto the watch state', async () => {
      const record: ProjectPrefsRecord = {
        projects: { a: { gitBranch: 'feature', isGitRepo: true } },
        groups: [{ id: 'g', name: 'Group', projectIds: ['a'] }],
        order: ['b', 'a'],
        updatedAt: 't'
      }
      h.store.set('project-prefs', record)

      await mountAndDeliver(list([summary('a'), summary('b')]))

      const state = useProjectStore.getState()
      expect(state.projects.map((p) => p.id)).toEqual(['b', 'a'])
      expect(state.projects[1]).toMatchObject({ gitBranch: 'feature', isGitRepo: true })
      expect(state.groups.map((g) => g.name)).toEqual(['Group'])
    })

    it('saves the prefs when a client-only field changes, never the registry fields', async () => {
      await mountAndDeliver(list([summary('a')]))

      act(() => useProjectStore.getState().updateProject('a', { defaultShell: '/bin/zsh' }))

      await waitFor(() => {
        const saved = h.store.get('project-prefs') as ProjectPrefsRecord | undefined
        expect(saved?.projects.a).toEqual({ defaultShell: '/bin/zsh' })
      })
      expect(JSON.stringify(h.store.get('project-prefs'))).not.toContain('/work/a')
    })
  })

  describe('prefs read failure', () => {
    it('saves a group created after the first prefs read failed', async () => {
      vi.mocked(persistenceApi.read).mockImplementationOnce(async () => ({
        success: false,
        code: 'TIMEOUT',
        error: 'store socket did not answer'
      }))

      await mountAndDeliver(list([summary('a')]))
      act(() => useProjectStore.getState().addGroup('Survives restart'))

      await waitFor(() => {
        const saved = h.store.get('project-prefs') as ProjectPrefsRecord | undefined
        expect(saved?.groups.map((g) => g.name)).toEqual(['Survives restart'])
      })
    })

    it('keeps the saved groups and saves again once the prefs read recovers', async () => {
      h.store.set('project-prefs', {
        projects: {},
        groups: [{ id: 'g-old', name: 'Old group', projectIds: [] }],
        order: [],
        updatedAt: 't'
      } satisfies ProjectPrefsRecord)
      // Every boot attempt fails: the store socket is still not answering.
      const boot = 1 + 3
      for (let i = 0; i < boot; i++) {
        vi.mocked(persistenceApi.read).mockImplementationOnce(async () => ({
          success: false,
          code: 'TIMEOUT',
          error: 'store socket did not answer'
        }))
      }

      // The boot retries take a few seconds, so wait for the watch past the default.
      mount()
      await waitFor(() => expect(h.subscribe).toHaveBeenCalled(), { timeout: 8000 })
      act(() => watchHandlers().onState(list([summary('a')])))
      await waitFor(() => expect(useProjectStore.getState().isLoaded).toBe(true))
      act(() => useProjectStore.getState().addGroup('Made while unreadable'))

      await waitFor(
        () => {
          const saved = h.store.get('project-prefs') as ProjectPrefsRecord | undefined
          expect(saved?.groups.map((g) => g.name)).toEqual(['Made while unreadable', 'Old group'])
        },
        { timeout: 9000 }
      )
      expect(useProjectStore.getState().groups.map((g) => g.name)).toEqual([
        'Made while unreadable',
        'Old group'
      ])
    }, 15000)

    it('keeps a listed project saved prefs after the read recovers', async () => {
      h.store.set('project-prefs', {
        projects: { a: { defaultShell: '/bin/zsh', gitBranch: 'feature' } },
        groups: [],
        order: [],
        updatedAt: 't'
      } satisfies ProjectPrefsRecord)
      for (let i = 0; i < 1 + 3; i++) {
        vi.mocked(persistenceApi.read).mockImplementationOnce(async () => ({
          success: false,
          code: 'TIMEOUT',
          error: 'store socket did not answer'
        }))
      }

      mount()
      await waitFor(() => expect(h.subscribe).toHaveBeenCalled(), { timeout: 8000 })
      act(() => watchHandlers().onState(list([summary('a')])))
      await waitFor(() => expect(useProjectStore.getState().isLoaded).toBe(true))
      act(() => useProjectStore.getState().addGroup('Triggers a save'))

      // The group only reaches the record once the read has recovered and saving is on.
      await waitFor(
        () => {
          const saved = h.store.get('project-prefs') as ProjectPrefsRecord | undefined
          expect(saved?.groups.map((g) => g.name)).toEqual(['Triggers a save'])
        },
        { timeout: 9000 }
      )
      const saved = h.store.get('project-prefs') as ProjectPrefsRecord
      expect(saved.projects.a).toMatchObject({ defaultShell: '/bin/zsh', gitBranch: 'feature' })
      expect(useProjectStore.getState().projects[0]).toMatchObject({
        defaultShell: '/bin/zsh',
        gitBranch: 'feature'
      })
    }, 15000)
  })

  describe('active project', () => {
    it('restores this device saved selection', async () => {
      h.store.set('active-project', 'b')

      await mountAndDeliver(list([summary('a'), summary('b')], 'a'))

      expect(useProjectStore.getState().activeProjectId).toBe('b')
    })

    it('lands on the host default without saving it as the device choice', async () => {
      await mountAndDeliver(list([summary('a'), summary('b')], 'b'))

      expect(useProjectStore.getState().activeProjectId).toBe('b')
      expect(persistenceApi.write).not.toHaveBeenCalledWith('active-project', expect.anything())
    })

    it('lands on the first project that is not archived when there is no default', async () => {
      await mountAndDeliver(list([summary('a', { isArchived: true }), summary('b')], null))

      expect(useProjectStore.getState().activeProjectId).toBe('b')
    })

    it('keeps the device selection through a delta that moves the host default', async () => {
      await mountAndDeliver(list([summary('a'), summary('b')], 'a'))
      act(() => useProjectStore.getState().selectProject('b'))

      act(() => watchHandlers().onDelta(list([summary('a'), summary('b')], 'a')))
      act(() => watchHandlers().onDelta(list([summary('a'), summary('b')], 'b')))

      await waitFor(() => expect(useProjectStore.getState().projects[1].isDefault).toBeDefined())
      expect(useProjectStore.getState().activeProjectId).toBe('b')
      expect(persistenceApi.write).toHaveBeenCalledWith('active-project', 'b')
    })
  })

  describe('desktop', () => {
    it('grants the fs scope of every listed root once, not again for known ones', async () => {
      h.tauri.value = true

      await mountAndDeliver(list([summary('a'), summary('b')]))
      expect(h.grantFsScope).toHaveBeenCalledTimes(1)
      expect(h.grantFsScope).toHaveBeenCalledWith(['/work/a', '/work/b'])

      act(() => watchHandlers().onDelta(list([summary('a'), summary('b'), summary('c')])))
      await waitFor(() => expect(h.grantFsScope).toHaveBeenCalledTimes(2))
      expect(h.grantFsScope).toHaveBeenLastCalledWith(['/work/c'])
    })

    it('applies only the newest list that arrived while an earlier one was being applied', async () => {
      h.tauri.value = true
      let release: () => void = () => {}
      h.grantFsScope.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ success: true, data: undefined })
          })
      )
      mount()
      await waitFor(() => expect(h.subscribe).toHaveBeenCalled())

      act(() => {
        watchHandlers().onState(list([summary('first')]))
        watchHandlers().onDelta(list([summary('second')]))
        watchHandlers().onDelta(list([summary('third')]))
      })
      await waitFor(() => expect(h.grantFsScope).toHaveBeenCalledTimes(1))
      release()

      await waitFor(() =>
        expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['third'])
      )
      expect(h.grantFsScope).not.toHaveBeenCalledWith(['/work/second'])
    })

    it('mirrors the MCP registry when the host default moves while shared-live runs', async () => {
      h.tauri.value = true
      useRemoteStatusStore.getState().setStatus({ running: true } as never)
      await mountAndDeliver(list([summary('a'), summary('b')], 'a'))
      expect(h.syncMcp).not.toHaveBeenCalled()

      act(() => watchHandlers().onDelta(list([summary('a'), summary('b')], 'a')))
      expect(h.syncMcp).not.toHaveBeenCalled()

      act(() => watchHandlers().onDelta(list([summary('a'), summary('b')], 'b')))
      await waitFor(() => expect(h.syncMcp).toHaveBeenCalledTimes(1))
      // The mirror names the device's active project, not the host default.
      expect(h.syncMcp).toHaveBeenCalledWith('a')
    })

    it('does not mirror the MCP registry when shared-live is off', async () => {
      h.tauri.value = true
      await mountAndDeliver(list([summary('a'), summary('b')], 'a'))

      act(() => watchHandlers().onDelta(list([summary('a'), summary('b')], 'b')))

      await waitFor(() => expect(useProjectStore.getState().projects[1].isDefault).toBeDefined())
      expect(h.syncMcp).not.toHaveBeenCalled()
    })
  })

  it('stops watching and applying after unmount', async () => {
    const { unmount } = await mountAndDeliver(list([summary('a')]))

    unmount()

    expect(h.unwatch).toHaveBeenCalledTimes(1)
  })
})
