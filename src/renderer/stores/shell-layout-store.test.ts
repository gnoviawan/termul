import { PersistenceKeys } from '@shared/types/persistence.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import {
  defaultShellLayoutRecord,
  resetShellLayoutStoreForTests,
  SHELL_LAYOUT_BOUNDS,
  sanitizeShellLayout,
  useShellLayoutStore
} from './shell-layout-store'

const { mockRead, mockWrite, mockWriteDebounced, mockDelete, mockLog, mockLegacy } = vi.hoisted(
  () => ({
    mockRead: vi.fn(),
    mockWrite: vi.fn(),
    mockWriteDebounced: vi.fn(),
    mockDelete: vi.fn(),
    mockLog: vi.fn(),
    mockLegacy: vi.fn()
  })
)

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: mockRead,
    write: mockWrite,
    writeDebounced: mockWriteDebounced,
    delete: mockDelete
  }
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))

// Legacy sources are read by the migration module; its own tests cover that.
vi.mock('@/lib/shell-layout-migration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shell-layout-migration')>()
  return { ...actual, readLegacyShellLayoutSources: mockLegacy }
})

const NOT_FOUND = { success: false, code: 'KEY_NOT_FOUND', error: 'Key not found' }

function state() {
  return useShellLayoutStore.getState()
}

async function hydrateWithRecord(record: unknown = defaultShellLayoutRecord()): Promise<void> {
  mockRead.mockResolvedValueOnce({ success: true, data: record })
  await state().hydrate()
}

describe('shell-layout-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetShellLayoutStoreForTests()
    useAgentChatLifetimeStore.setState({
      retainedByProject: {},
      activeSessionByProject: {},
      focusSessionByProject: {}
    })
    mockRead.mockResolvedValue(NOT_FOUND)
    mockWrite.mockResolvedValue({ success: true, data: undefined })
    mockWriteDebounced.mockResolvedValue({ success: true, data: undefined })
    mockDelete.mockResolvedValue({ success: true, data: undefined })
    mockLog.mockResolvedValue(undefined)
    mockLegacy.mockResolvedValue({
      appSettings: null,
      explorerWidth: null,
      sshHeight: null,
      projects: null
    })
  })

  describe('defaults', () => {
    it('starts idle with the documented defaults and an open graph', () => {
      expect(state()).toMatchObject({
        status: 'idle',
        railExpanded: true,
        railWidth: 200,
        sidePanelVisible: true,
        sidePanelWidth: 260,
        sshSectionVisible: true,
        sshSectionHeight: 140,
        graphHeight: 240,
        graphOpen: true,
        lastColumnTabByProject: {},
        worktreePickByProject: {}
      })
    })
  })

  describe('sanitizeShellLayout', () => {
    it('clamps every number to its bounds and rounds', () => {
      const record = sanitizeShellLayout({
        railWidth: 9999,
        sidePanelWidth: 1,
        sshSectionHeight: 399.6,
        graphHeight: -5
      })
      expect(record.railWidth).toBe(SHELL_LAYOUT_BOUNDS.railWidth.max)
      expect(record.sidePanelWidth).toBe(SHELL_LAYOUT_BOUNDS.sidePanelWidth.min)
      expect(record.sshSectionHeight).toBe(400)
      expect(record.graphHeight).toBe(SHELL_LAYOUT_BOUNDS.graphHeight.min)
    })

    it('falls back to defaults for non-numbers and non-booleans', () => {
      const record = sanitizeShellLayout({
        railWidth: '300',
        sidePanelWidth: Number.NaN,
        railExpanded: 'yes',
        sidePanelVisible: 1
      })
      expect(record.railWidth).toBe(200)
      expect(record.sidePanelWidth).toBe(260)
      expect(record.railExpanded).toBe(true)
      expect(record.sidePanelVisible).toBe(true)
    })

    it('drops invalid map entries, SSH as a last tab, and unknown fields', () => {
      const record = sanitizeShellLayout({
        lastColumnTabByProject: { a: 'chats', b: 'ssh', c: 7, d: 'changes' },
        worktreePickByProject: { a: 'C:/repo/wt', b: 3, c: '' },
        somethingElse: true
      })
      expect(record.lastColumnTabByProject).toEqual({ a: 'chats', d: 'changes' })
      expect(record.worktreePickByProject).toEqual({ a: 'C:/repo/wt' })
      expect(record).not.toHaveProperty('somethingElse')
    })

    it('returns defaults for non-object input', () => {
      expect(sanitizeShellLayout(null)).toEqual(defaultShellLayoutRecord())
      expect(sanitizeShellLayout('x')).toEqual(defaultShellLayoutRecord())
    })
  })

  describe('hydration gate', () => {
    it('ignores mutations while idle and never writes', () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
      state().setRailWidth(300)
      state().setLastColumnTab('p1', 'explorer')
      state().setGraphOpen(false)
      expect(state().railWidth).toBe(200)
      expect(state().lastColumnTabByProject).toEqual({})
      expect(state().graphOpen).toBe(true)
      expect(mockWriteDebounced).not.toHaveBeenCalled()
      expect(debug).toHaveBeenCalled()
      debug.mockRestore()
    })

    it('ignores mutations while hydrating', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
      let release: (value: unknown) => void = () => undefined
      mockRead.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        })
      )
      const pending = state().hydrate()
      expect(state().status).toBe('hydrating')
      state().setRailWidth(300)
      expect(state().railWidth).toBe(200)
      expect(mockWriteDebounced).not.toHaveBeenCalled()
      release({ success: true, data: { railWidth: 250 } })
      await pending
      expect(state().railWidth).toBe(250)
      debug.mockRestore()
    })

    it('is single-flight', async () => {
      mockRead.mockResolvedValue({ success: true, data: defaultShellLayoutRecord() })
      await Promise.all([state().hydrate(), state().hydrate()])
      await state().hydrate()
      expect(mockRead).toHaveBeenCalledTimes(1)
    })

    it('loads an existing record, clamped, and never migrates', async () => {
      await hydrateWithRecord({
        version: 1,
        railExpanded: false,
        railWidth: 5000,
        sidePanelVisible: false,
        sidePanelWidth: 400,
        sshSectionVisible: false,
        sshSectionHeight: 200,
        graphHeight: 300,
        lastColumnTabByProject: { p1: 'changes' },
        worktreePickByProject: { p1: 'c:/repo/wt' }
      })
      expect(state().status).toBe('ready')
      expect(state()).toMatchObject({
        railExpanded: false,
        railWidth: 360,
        sidePanelVisible: false,
        sidePanelWidth: 400,
        sshSectionVisible: false,
        sshSectionHeight: 200,
        graphHeight: 300,
        lastColumnTabByProject: { p1: 'changes' },
        worktreePickByProject: { p1: 'c:/repo/wt' }
      })
      expect(mockLegacy).not.toHaveBeenCalled()
      expect(mockWrite).not.toHaveBeenCalled()
      expect(mockWriteDebounced).not.toHaveBeenCalled()
    })

    it('goes unavailable on a read error: in-memory defaults, never a write', async () => {
      mockRead.mockResolvedValueOnce({ success: false, code: 'READ_ERROR', error: 'boom' })
      await state().hydrate()
      expect(state().status).toBe('unavailable')
      expect(mockLegacy).not.toHaveBeenCalled()
      expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))

      state().setRailWidth(300)
      state().setSidePanelVisible(false)
      expect(state().railWidth).toBe(300)
      expect(state().sidePanelVisible).toBe(false)
      expect(mockWrite).not.toHaveBeenCalled()
      expect(mockWriteDebounced).not.toHaveBeenCalled()
    })

    it('goes unavailable when the read itself throws', async () => {
      mockRead.mockRejectedValueOnce(new Error('ipc down'))
      await state().hydrate()
      expect(state().status).toBe('unavailable')
      state().setRailExpanded(false)
      expect(mockWriteDebounced).not.toHaveBeenCalled()
    })

    it('goes unavailable for a newer version and keeps the saved record untouched', async () => {
      await hydrateWithRecord({ version: 2, railWidth: 333 })
      expect(state().status).toBe('unavailable')
      expect(state().railWidth).toBe(200)
      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', message: expect.stringContaining('version 2') })
      )
      state().setRailWidth(250)
      expect(state().railWidth).toBe(250)
      expect(mockWrite).not.toHaveBeenCalled()
      expect(mockWriteDebounced).not.toHaveBeenCalled()
    })
  })

  describe('migration on first boot', () => {
    it('writes the migrated, version-marked record once, immediately', async () => {
      mockLegacy.mockResolvedValueOnce({
        appSettings: { sidebarVisible: false, fileExplorerVisible: false, sshPanelVisible: false },
        explorerWidth: '400',
        sshHeight: '200',
        projects: {
          projects: [
            {
              id: 'p1',
              activeWorktreeId: 'w1',
              worktrees: [{ id: 'w1', path: 'C:\\Repo\\.termul\\worktrees\\feat' }]
            }
          ]
        }
      })
      await state().hydrate()

      expect(state().status).toBe('ready')
      expect(mockWrite).toHaveBeenCalledTimes(1)
      expect(mockWrite).toHaveBeenCalledWith(PersistenceKeys.shellLayout, {
        version: 1,
        railExpanded: false,
        railWidth: 200,
        sidePanelVisible: false,
        sidePanelWidth: 400,
        sshSectionVisible: false,
        sshSectionHeight: 200,
        graphHeight: 240,
        lastColumnTabByProject: {},
        worktreePickByProject: { p1: 'c:/repo/.termul/worktrees/feat' }
      })
      expect(mockWriteDebounced).not.toHaveBeenCalled()
      const message = mockLog.mock.calls.map(([payload]) => payload.message).join('\n')
      expect(message).toContain('[shell-migrate] migrated')
      expect(message).not.toContain('Repo')
    })

    it('writes defaults on a fresh install', async () => {
      await state().hydrate()
      expect(mockWrite).toHaveBeenCalledWith(
        PersistenceKeys.shellLayout,
        defaultShellLayoutRecord()
      )
    })

    it('stays usable and logs when the migration write fails', async () => {
      mockWrite.mockResolvedValueOnce({ success: false, code: 'WRITE_ERROR', error: 'disk' })
      await state().hydrate()
      expect(state().status).toBe('ready')
      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('[shell-migrate] write failed')
        })
      )
    })
  })

  describe('actions once ready', () => {
    beforeEach(async () => {
      await hydrateWithRecord()
    })

    it('clamps sizes and persists the full snapshot with writeDebounced', () => {
      state().setRailWidth(9999)
      state().setSidePanelWidth(10)
      state().setSshSectionHeight(60.4)
      state().setGraphHeight(9999)
      expect(state()).toMatchObject({
        railWidth: 360,
        sidePanelWidth: 220,
        sshSectionHeight: 60,
        graphHeight: 600
      })
      expect(mockWriteDebounced).toHaveBeenCalledTimes(4)
      expect(mockWriteDebounced).toHaveBeenLastCalledWith(
        PersistenceKeys.shellLayout,
        expect.objectContaining({
          version: 1,
          railWidth: 360,
          sidePanelWidth: 220,
          sshSectionHeight: 60,
          graphHeight: 600
        })
      )
      expect(mockWrite).not.toHaveBeenCalled()
    })

    it('toggles booleans and ignores non-booleans', () => {
      state().setRailExpanded(false)
      state().setSidePanelVisible(false)
      state().setSshSectionVisible(false)
      expect(state()).toMatchObject({
        railExpanded: false,
        sidePanelVisible: false,
        sshSectionVisible: false
      })
      mockWriteDebounced.mockClear()
      state().setRailExpanded('x' as unknown as boolean)
      expect(state().railExpanded).toBe(false)
      expect(mockWriteDebounced).not.toHaveBeenCalled()
    })

    it('keeps graphOpen in memory only', () => {
      state().setGraphOpen(false)
      expect(state().graphOpen).toBe(false)
      expect(mockWriteDebounced).not.toHaveBeenCalled()
      state().setRailWidth(250)
      const snapshot = mockWriteDebounced.mock.calls.at(-1)?.[1] as Record<string, unknown>
      expect(snapshot).not.toHaveProperty('graphOpen')
      expect(snapshot).not.toHaveProperty('status')
    })

    it('remembers the last column tab per project and ignores ssh or unknown tabs', () => {
      state().setLastColumnTab('p1', 'explorer')
      state().setLastColumnTab('p2', 'changes')
      state().setLastColumnTab('p1', 'ssh' as unknown as 'chats')
      expect(state().lastColumnTabByProject).toEqual({ p1: 'explorer', p2: 'changes' })
    })

    it('stores a normalized worktree pick and clears it with null', () => {
      state().setWorktreePick('p1', 'C:\\Repo\\wt\\')
      expect(state().worktreePickByProject).toEqual({ p1: 'c:/repo/wt' })
      state().setWorktreePick('p1', null)
      expect(state().worktreePickByProject).toEqual({})
    })

    it('logs a failed persist without throwing', async () => {
      mockWriteDebounced.mockResolvedValueOnce({ success: false, code: 'WRITE_ERROR' })
      state().setRailWidth(250)
      await vi.waitFor(() =>
        expect(mockLog).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining('persist failed') })
        )
      )
      expect(state().railWidth).toBe(250)
    })
  })

  describe('removeProject', () => {
    it('drops map entries, editor state and retained chats', async () => {
      await hydrateWithRecord({
        lastColumnTabByProject: { p1: 'chats', p2: 'explorer' },
        worktreePickByProject: { p1: 'c:/a', p2: 'c:/b' }
      })
      useAgentChatLifetimeStore.setState({
        retainedByProject: { p1: ['s1'], p2: ['s2'] },
        activeSessionByProject: { p1: 's1', p2: 's2' },
        focusSessionByProject: { p1: 's1' }
      })
      mockWriteDebounced.mockClear()

      await state().removeProject('p1')

      expect(state().lastColumnTabByProject).toEqual({ p2: 'explorer' })
      expect(state().worktreePickByProject).toEqual({ p2: 'c:/b' })
      expect(mockDelete).toHaveBeenCalledWith('workspace/p1')
      const lifetime = useAgentChatLifetimeStore.getState()
      expect(lifetime.retainedByProject).toEqual({ p2: ['s2'] })
      expect(lifetime.activeSessionByProject).toEqual({ p2: 's2' })
      expect(lifetime.focusSessionByProject).toEqual({})
      expect(mockWriteDebounced).toHaveBeenCalledTimes(1)
    })

    it('continues when the workspace record delete fails, and logs it', async () => {
      await hydrateWithRecord({ worktreePickByProject: { p1: 'c:/a' } })
      useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })
      mockDelete.mockResolvedValueOnce({ success: false, code: 'DELETE_ERROR', error: 'x' })

      await state().removeProject('p1')

      expect(state().worktreePickByProject).toEqual({})
      expect(useAgentChatLifetimeStore.getState().retainedByProject).toEqual({})
      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('workspace record cleanup failed')
        })
      )
    })

    it('drops a project removed while hydrating from the loaded record and persists', async () => {
      let release: (value: unknown) => void = () => undefined
      mockRead.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
      const pending = state().hydrate()

      await state().removeProject('p1')
      expect(mockDelete).toHaveBeenCalledWith('workspace/p1')

      release({
        success: true,
        data: {
          version: 1,
          lastColumnTabByProject: { p1: 'chats', p2: 'explorer' },
          worktreePickByProject: { p1: 'c:/a', p2: 'c:/b' }
        }
      })
      await pending

      expect(state().status).toBe('ready')
      expect(state().lastColumnTabByProject).toEqual({ p2: 'explorer' })
      expect(state().worktreePickByProject).toEqual({ p2: 'c:/b' })
      expect(mockWriteDebounced).toHaveBeenCalledTimes(1)
      expect(mockWriteDebounced.mock.calls[0][1]).toMatchObject({
        worktreePickByProject: { p2: 'c:/b' }
      })
    })

    it('never records a removed project legacy pick in the migrated record', async () => {
      let release: (value: unknown) => void = () => undefined
      mockRead.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
      mockLegacy.mockResolvedValueOnce({
        appSettings: null,
        explorerWidth: null,
        sshHeight: null,
        projects: {
          projects: [
            { id: 'p1', activeWorktreeId: 'w1', worktrees: [{ id: 'w1', path: 'C:/r/wt1' }] },
            { id: 'p2', activeWorktreeId: 'w2', worktrees: [{ id: 'w2', path: 'C:/r/wt2' }] }
          ]
        }
      })
      const pending = state().hydrate()

      await state().removeProject('p1')
      release(NOT_FOUND)
      await pending

      expect(state().status).toBe('ready')
      expect(state().worktreePickByProject).toEqual({ p2: 'c:/r/wt2' })
      expect(mockWrite).toHaveBeenCalledTimes(1)
      expect(mockWrite.mock.calls[0][1]).toMatchObject({
        worktreePickByProject: { p2: 'c:/r/wt2' }
      })
    })

    it('queues a removal made before hydration starts and applies it once unavailable, without writing', async () => {
      await state().removeProject('p1')
      mockRead.mockResolvedValueOnce({ success: false, code: 'READ_ERROR' })
      await state().hydrate()

      expect(state().status).toBe('unavailable')
      expect(mockWrite).not.toHaveBeenCalled()
      expect(mockWriteDebounced).not.toHaveBeenCalled()
    })

    it('still cleans editor state and chats when the layout is unavailable, without writing', async () => {
      mockRead.mockResolvedValueOnce({ success: false, code: 'READ_ERROR' })
      await state().hydrate()
      useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })

      await state().removeProject('p1')

      expect(mockDelete).toHaveBeenCalledWith('workspace/p1')
      expect(useAgentChatLifetimeStore.getState().retainedByProject).toEqual({})
      expect(mockWriteDebounced).not.toHaveBeenCalled()
    })
  })
})
