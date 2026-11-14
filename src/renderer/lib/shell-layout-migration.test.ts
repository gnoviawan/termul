import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildMigratedShellLayout,
  countLegacyShellLayoutSources,
  LEGACY_EXPLORER_WIDTH_KEY,
  LEGACY_SSH_HEIGHT_KEY,
  type LegacyShellLayoutSources,
  readLegacyShellLayoutSources,
  upgradeShellLayoutRecord
} from './shell-layout-migration'
import { defaultShellLayoutRecord } from './shell-layout-record'

const { mockRead, tauriRef } = vi.hoisted(() => ({
  mockRead: vi.fn(),
  tauriRef: { current: true as boolean }
}))

vi.mock('@/lib/api', () => ({ persistenceApi: { read: mockRead } }))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => tauriRef.current }))

const EMPTY: LegacyShellLayoutSources = {
  appSettings: null,
  explorerWidth: null,
  sshHeight: null,
  projects: null
}

function projectsWith(activeWorktreeId: string | null, path: string | undefined = 'C:\\R\\wt') {
  return {
    projects: [
      {
        id: 'p1',
        activeWorktreeId,
        worktrees: [
          { id: 'w1', name: 'wt', branch: 'b', ...(path === null ? {} : { path }), createdAt: 'x' }
        ]
      }
    ]
  }
}

describe('buildMigratedShellLayout', () => {
  it('returns the defaults when nothing is persisted', () => {
    expect(buildMigratedShellLayout(EMPTY)).toEqual(defaultShellLayoutRecord())
  })

  it('carries over flags, widths and the desktop worktree pick', () => {
    const record = buildMigratedShellLayout({
      appSettings: { sidebarVisible: false, fileExplorerVisible: false, sshPanelVisible: false },
      explorerWidth: '400',
      sshHeight: '200',
      projects: projectsWith('w1')
    })
    expect(record).toEqual({
      ...defaultShellLayoutRecord(),
      railExpanded: false,
      sidePanelVisible: false,
      sshSectionVisible: false,
      sidePanelWidth: 400,
      sshSectionHeight: 200,
      worktreePickByProject: { p1: 'c:/r/wt' }
    })
  })

  it('reads raw values: an absent flag stays at the default, not the settings default', () => {
    const record = buildMigratedShellLayout({
      ...EMPTY,
      appSettings: { fileExplorerVisible: false, terminalFontSize: 14 }
    })
    expect(record.railExpanded).toBe(true)
    expect(record.sshSectionVisible).toBe(true)
    expect(record.sidePanelVisible).toBe(false)
  })

  it('ignores non-boolean flags', () => {
    const record = buildMigratedShellLayout({
      ...EMPTY,
      appSettings: { sidebarVisible: 'false', fileExplorerVisible: 0, sshPanelVisible: null }
    })
    expect(record.railExpanded).toBe(true)
    // The default: the main screen opens without the right panel (Paper 2.2).
    expect(record.sidePanelVisible).toBe(false)
    expect(record.sshSectionVisible).toBe(true)
  })

  it('clamps out-of-bounds legacy widths', () => {
    const record = buildMigratedShellLayout({ ...EMPTY, explorerWidth: '9999', sshHeight: '1' })
    expect(record.sidePanelWidth).toBe(560)
    expect(record.sshSectionHeight).toBe(48)
  })

  it('uses defaults for garbage widths and parses leading integers', () => {
    expect(buildMigratedShellLayout({ ...EMPTY, explorerWidth: 'abc', sshHeight: '' })).toEqual(
      defaultShellLayoutRecord()
    )
    expect(buildMigratedShellLayout({ ...EMPTY, explorerWidth: '300px' }).sidePanelWidth).toBe(300)
  })

  it('skips a dangling activeWorktreeId, a missing path and a null id', () => {
    expect(buildMigratedShellLayout({ ...EMPTY, projects: projectsWith('nope') })).toEqual(
      defaultShellLayoutRecord()
    )
    expect(
      buildMigratedShellLayout({
        ...EMPTY,
        projects: projectsWith('w1', null)
      }).worktreePickByProject
    ).toEqual({})
    expect(
      buildMigratedShellLayout({ ...EMPTY, projects: projectsWith(null) }).worktreePickByProject
    ).toEqual({})
  })

  it('tolerates malformed projects data', () => {
    for (const projects of [null, 'x', { projects: 'x' }, { projects: [null, 4, { id: 1 }] }]) {
      expect(buildMigratedShellLayout({ ...EMPTY, projects })).toEqual(defaultShellLayoutRecord())
    }
  })
})

describe('countLegacyShellLayoutSources', () => {
  it('counts only values that fed the record', () => {
    expect(
      countLegacyShellLayoutSources({
        appSettings: { sidebarVisible: true, sshPanelVisible: 'x' },
        explorerWidth: '300',
        sshHeight: 'NaN',
        projects: projectsWith('w1')
      })
    ).toEqual({ flags: 1, widths: 1, picks: 1 })
  })
})

describe('readLegacyShellLayoutSources', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriRef.current = true
    localStorage.clear()
  })

  it('reads raw settings/app, projects and the two localStorage keys on desktop', async () => {
    localStorage.setItem(LEGACY_EXPLORER_WIDTH_KEY, '321')
    localStorage.setItem(LEGACY_SSH_HEIGHT_KEY, '111')
    mockRead.mockImplementation(async (key: string) => ({
      success: true,
      data: key === 'settings/app' ? { sidebarVisible: false } : { projects: [] }
    }))

    const sources = await readLegacyShellLayoutSources()

    expect(sources).toEqual({
      appSettings: { sidebarVisible: false },
      explorerWidth: '321',
      sshHeight: '111',
      projects: { projects: [] }
    })
    expect(mockRead).toHaveBeenCalledWith('settings/app')
    expect(mockRead).toHaveBeenCalledWith('projects')
  })

  it('never reads projects on web', async () => {
    tauriRef.current = false
    mockRead.mockResolvedValue({ success: true, data: { sidebarVisible: true } })

    const sources = await readLegacyShellLayoutSources()

    expect(mockRead).toHaveBeenCalledTimes(1)
    expect(mockRead).toHaveBeenCalledWith('settings/app')
    expect(sources.projects).toBeNull()
  })

  it('treats failed or throwing reads and blocked localStorage as absent', async () => {
    mockRead.mockResolvedValueOnce({ success: false, code: 'KEY_NOT_FOUND' })
    mockRead.mockRejectedValueOnce(new Error('boom'))
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    const sources = await readLegacyShellLayoutSources()

    expect(sources).toEqual(EMPTY)
    getItem.mockRestore()
  })
})

describe('upgradeShellLayoutRecord (version 3)', () => {
  it('turns a remembered chats view into explorer and keeps everything else', () => {
    const raw = {
      version: 2,
      sidePanelVisible: true,
      sidePanelWidth: 300,
      lastColumnTabByProject: { a: 'chats', b: 'changes', c: 'github', d: 'explorer' }
    }
    expect(upgradeShellLayoutRecord(raw)).toEqual({
      ...raw,
      lastColumnTabByProject: { a: 'explorer', b: 'changes', c: 'github', d: 'explorer' }
    })
  })

  it('treats a record without a version as old', () => {
    expect(upgradeShellLayoutRecord({ lastColumnTabByProject: { a: 'chats' } })).toEqual({
      lastColumnTabByProject: { a: 'explorer' }
    })
  })

  it('leaves a current or newer record, and non-object data, as is', () => {
    const current = { version: 3, lastColumnTabByProject: { a: 'chats' } }
    expect(upgradeShellLayoutRecord(current)).toBe(current)
    const newer = { version: 4, lastColumnTabByProject: { a: 'chats' } }
    expect(upgradeShellLayoutRecord(newer)).toBe(newer)
    expect(upgradeShellLayoutRecord(null)).toBeNull()
    expect(upgradeShellLayoutRecord('x')).toBe('x')
    const noTabs = { version: 2 }
    expect(upgradeShellLayoutRecord(noTabs)).toBe(noTabs)
  })

  it('does not touch the prototype for a hostile key', () => {
    const raw = JSON.parse('{"version":2,"lastColumnTabByProject":{"__proto__":"chats"}}')
    const upgraded = upgradeShellLayoutRecord(raw) as { lastColumnTabByProject: object }
    expect(Object.getPrototypeOf(upgraded.lastColumnTabByProject)).toBe(Object.prototype)
  })
})
