import { act, renderHook } from '@testing-library/react'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { conversationToken, fileToken } from '@/lib/skill-tokens'
import { useAcpStore } from '@/stores/acp-store'
import { tryHandleMentionMenuKeyDown } from './mention-menu-keyboard'
import type { MentionMatch, MentionRow } from './mention-menu-model'
import type { ComposerKeyboardEvent } from './slash-menu-keyboard'
import { type ComposerMentions, useComposerMentions } from './use-composer-mentions'

const { mockApi, batchCbs, doneCbs, mockIsTauri, mockLog, mockUuid } = vi.hoisted(() => {
  const batch: Array<(e: never) => void> = []
  const done: Array<(e: never) => void> = []
  return {
    batchCbs: batch,
    doneCbs: done,
    mockApi: {
      searchFileNamesStreamStart: vi.fn(),
      readDirectory: vi.fn(),
      searchFileNamesStreamCancel: vi.fn(async () => ({ success: true as const })),
      onSearchFileNamesBatch: vi.fn((cb: (e: never) => void) => {
        batch.push(cb)
        return () => {
          const i = batch.indexOf(cb)
          if (i >= 0) batch.splice(i, 1)
        }
      }),
      onSearchFileNamesDone: vi.fn((cb: (e: never) => void) => {
        done.push(cb)
        return () => {
          const i = done.indexOf(cb)
          if (i >= 0) done.splice(i, 1)
        }
      })
    },
    mockIsTauri: vi.fn(() => true),
    mockLog: vi.fn(async () => {}),
    mockUuid: vi.fn(() => 'inst')
  }
})

vi.mock('@/lib/api', () => ({ filesystemApi: mockApi }))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: mockIsTauri }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))
vi.mock('@/lib/uuid', () => ({ randomUUID: mockUuid }))

interface BatchEvent {
  searchId: string
  files: Array<{ path: string; ignored: boolean; kind?: 'file' | 'dir' }>
  truncated?: boolean
}
interface DoneEvent {
  searchId: string
  truncated: boolean
  totalFiles: number
  code?: string
  error?: string
}

const emitBatch = (e: BatchEvent) =>
  act(() => {
    for (const cb of [...batchCbs]) (cb as (e: BatchEvent) => void)(e)
  })
const emitDone = (e: DoneEvent) =>
  act(() => {
    for (const cb of [...doneCbs]) (cb as (e: DoneEvent) => void)(e)
  })
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

const match = (relPath: string, ignored = false): MentionMatch => ({
  relPath,
  absPath: `/work/${relPath}`,
  name: relPath.split('/').pop() ?? relPath,
  ignored
})

function renderMentions(overrides: Partial<Parameters<typeof useComposerMentions>[0]> = {}) {
  const onStageFileRef = vi.fn()
  const result = renderHook(() =>
    useComposerMentions({
      rootPath: '/work',
      projectId: 'proj',
      currentSessionId: 'self',
      disabled: false,
      recents: [],
      onStageFileRef,
      ...overrides
    })
  )
  return { ...result, onStageFileRef }
}

describe('useComposerMentions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockApi.searchFileNamesStreamStart.mockReset()
    mockApi.searchFileNamesStreamStart.mockResolvedValue({ success: true as const })
    mockApi.searchFileNamesStreamCancel.mockReset()
    mockApi.searchFileNamesStreamCancel.mockResolvedValue({ success: true as const })
    mockApi.onSearchFileNamesBatch.mockClear()
    mockApi.onSearchFileNamesDone.mockClear()
    batchCbs.length = 0
    doneCbs.length = 0
    mockIsTauri.mockReset()
    mockIsTauri.mockReturnValue(true)
    mockLog.mockReset()
    mockLog.mockResolvedValue(undefined)
    mockUuid.mockReset()
    mockUuid.mockReturnValue('inst')
    mockApi.readDirectory.mockReset()
    mockApi.readDirectory.mockResolvedValue({ success: true, data: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes once per mount and unlistens on unmount', () => {
    const { unmount } = renderMentions()
    expect(mockApi.onSearchFileNamesBatch).toHaveBeenCalledTimes(1)
    expect(mockApi.onSearchFileNamesDone).toHaveBeenCalledTimes(1)
    unmount()
    expect(batchCbs).toHaveLength(0)
    expect(doneCbs).toHaveLength(0)
  })

  it('fires a debounced stream on @query and maps SearchFileHit -> MentionMatch', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@rea', 4))
    expect(result.current.menuOpen).toBe(true)
    expect(result.current.filter).toBe('rea')
    // During the debounce window no search has started yet.
    expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)

    await advance(90)
    expect(mockApi.searchFileNamesStreamStart).toHaveBeenCalledWith(
      'search-inst-1',
      '/work',
      '/work',
      'rea',
      true
    )
    expect(result.current.loading).toBe(true)

    emitBatch({
      searchId: 'search-inst-1',
      files: [
        { path: 'src/auth.ts', ignored: false },
        { path: 'build/x.ts', ignored: true }
      ]
    })
    expect(result.current.sections).toHaveLength(1)
    const items = result.current.sections[0].items
    expect(items).toHaveLength(2)
    expect(items[0].label).toBe('auth.ts')
    expect(items[0].description).toBe('src/auth.ts')
    expect(items[0].row).toEqual({ kind: 'file', match: match('src/auth.ts') })
    expect(items[0].ignored).toBe(false)
    expect(items[1].label).toBe('x.ts')
    expect(items[1].ignored).toBe(true)

    emitDone({ searchId: 'search-inst-1', truncated: false, totalFiles: 2 })
    expect(result.current.loading).toBe(false)
  })

  it('caps accumulated matches at MAX_RESULTS=100', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@rea', 4))
    await advance(90)
    const files = Array.from({ length: 150 }, (_, i) => ({
      path: `f${i}.ts`,
      ignored: false
    }))
    emitBatch({ searchId: 'search-inst-1', files })
    expect(result.current.sections[0].items).toHaveLength(100)
  })

  it('maps kind:dir hits to folder matches in a Folders section after Files', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@comp', 5))
    await advance(90)
    emitBatch({
      searchId: 'search-inst-1',
      files: [
        { path: 'src/components.ts', ignored: false },
        { path: 'src/renderer/components', ignored: false, kind: 'dir' },
        { path: 'node_modules/comp', ignored: true, kind: 'dir' }
      ]
    })
    expect(result.current.sections.map((s) => s.id)).toEqual(['files', 'folders'])
    const folders = result.current.sections[1].items
    expect(folders).toHaveLength(2)
    expect(folders[0].label).toBe('components')
    expect(folders[0].description).toBe('src/renderer/components')
    expect(folders[0].row).toEqual({
      kind: 'dir',
      match: {
        relPath: 'src/renderer/components',
        absPath: '/work/src/renderer/components/',
        name: 'components',
        ignored: false,
        kind: 'dir'
      }
    })
    expect(folders[1].ignored).toBe(true)
    // File rows stay byte-identical (no `kind` key).
    expect(result.current.sections[0].items[0].row).toEqual({
      kind: 'file',
      match: match('src/components.ts')
    })
  })

  it('caps folders independently so a full page of files never crowds them out', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@rea', 4))
    await advance(90)
    const files = Array.from({ length: 120 }, (_, i) => ({ path: `f${i}.ts`, ignored: false }))
    emitBatch({ searchId: 'search-inst-1', files })
    emitBatch({
      searchId: 'search-inst-1',
      files: Array.from({ length: 30 }, (_, i) => ({
        path: `d/dir${i}`,
        ignored: false,
        kind: 'dir' as const
      }))
    })
    const [filesSection, foldersSection] = result.current.sections
    expect(filesSection.items).toHaveLength(100)
    expect(foldersSection.items).toHaveLength(20)
  })

  it('dedupes cumulative desktop batches (files re-sent with the final folder batch)', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@comp', 5))
    await advance(90)
    const files = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.ts`, ignored: false }))
    emitBatch({ searchId: 'search-inst-1', files })
    emitBatch({
      searchId: 'search-inst-1',
      files: [...files, { path: 'src/components', ignored: false, kind: 'dir' as const }]
    })
    const [filesSection, foldersSection] = result.current.sections
    expect(filesSection.items).toHaveLength(25)
    expect(foldersSection.items).toHaveLength(1)
  })

  it('"Use this folder" splices a folder token (relative-path display, trailing-slash absPath)', async () => {
    const { result, onStageFileRef } = renderMentions()
    act(() => result.current.update('@comp', 5))
    await advance(90)
    const picked: MentionMatch = {
      relPath: 'src/renderer/components',
      absPath: '/work/src/renderer/components/',
      name: 'components',
      ignored: false,
      kind: 'dir'
    }
    let outcome: { value: string; caret: number } | null = null
    act(() => {
      outcome = result.current.select('@comp', 5, { kind: 'use-folder', match: picked })
    })
    const expectedToken = fileToken('src/renderer/components/', '/work/src/renderer/components/')
    expect(outcome).toEqual({ value: `${expectedToken} `, caret: expectedToken.length + 1 })
    expect(onStageFileRef).toHaveBeenCalledWith(picked)
    expect(result.current.menuOpen).toBe(false)
  })

  it('fires no search on a bare @ (empty filter) and opens on the categories', () => {
    const { result } = renderMentions({
      recents: [match('src/recent.ts'), match('README.md')]
    })
    act(() => result.current.update('@', 1))
    expect(result.current.menuOpen).toBe(true)
    expect(result.current.filter).toBe('')
    expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
    expect(result.current.sections.map((s) => s.id)).toEqual(['categories'])
    expect(result.current.canGoBack).toBe(false)
  })

  it('does not search when disabled', async () => {
    const { result } = renderMentions({ disabled: true })
    act(() => result.current.update('@rea', 4))
    await advance(90)
    expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })

  it('cancels the previous stream and id-gates stale batches on rapid typing', async () => {
    const { result } = renderMentions()
    // r -> re -> rea
    act(() => result.current.update('@r', 2))
    await advance(180)
    const firstSid = 'search-inst-1'
    expect(mockApi.searchFileNamesStreamStart).toHaveBeenLastCalledWith(
      firstSid,
      '/work',
      '/work',
      'r',
      true
    )

    act(() => result.current.update('@re', 3))
    // New keystroke cancels the in-flight stream before scheduling the next.
    expect(mockApi.searchFileNamesStreamCancel).toHaveBeenCalledWith(firstSid)
    await advance(180)
    const secondSid = 'search-inst-2'
    expect(mockApi.searchFileNamesStreamStart).toHaveBeenLastCalledWith(
      secondSid,
      '/work',
      '/work',
      're',
      true
    )

    act(() => result.current.update('@rea', 4))
    expect(mockApi.searchFileNamesStreamCancel).toHaveBeenCalledWith(secondSid)
    await advance(90)
    const thirdSid = 'search-inst-3'
    expect(mockApi.searchFileNamesStreamStart).toHaveBeenLastCalledWith(
      thirdSid,
      '/work',
      '/work',
      'rea',
      true
    )

    // Stale batch from the cancelled second search must be ignored.
    emitBatch({
      searchId: secondSid,
      files: [{ path: 'stale.ts', ignored: false }]
    })
    expect(result.current.sections).toHaveLength(0)

    // Current batch is accepted.
    emitBatch({
      searchId: thirdSid,
      files: [{ path: 'src/real.ts', ignored: false }]
    })
    expect(result.current.sections).toHaveLength(1)
    expect(result.current.sections[0].items[0].label).toBe('real.ts')

    emitDone({ searchId: thirdSid, truncated: false, totalFiles: 1 })
    expect(result.current.loading).toBe(false)
  })

  it('ignores stale done events from a cancelled search', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@re', 3))
    await advance(180)
    // Cancel by typing a new query.
    act(() => result.current.update('@rea', 4))
    await advance(90)
    // A late done for the cancelled search must not drop loading of the active one.
    emitDone({ searchId: 'search-inst-1', truncated: false, totalFiles: 0 })
    expect(result.current.loading).toBe(true)
    emitBatch({
      searchId: 'search-inst-2',
      files: [{ path: 'real.ts', ignored: false }]
    })
    expect(result.current.sections).toHaveLength(1)
    emitDone({ searchId: 'search-inst-2', truncated: false, totalFiles: 1 })
    expect(result.current.loading).toBe(false)
  })

  it('subscribes and searches on web too (issue #848) — same flow as desktop', async () => {
    mockIsTauri.mockReturnValue(false)
    const { result } = renderMentions({
      recents: [match('src/recent.ts')]
    })
    // The hook no longer gates on isTauriContext: web subscribes to the same
    // batch/done channel (the facade's in-module emitter) and starts the
    // debounced one-shot HTTP search.
    expect(mockApi.onSearchFileNamesBatch).toHaveBeenCalledTimes(1)
    expect(mockApi.onSearchFileNamesDone).toHaveBeenCalledTimes(1)
    act(() => result.current.update('@rea', 4))
    await advance(90)
    expect(mockApi.searchFileNamesStreamStart).toHaveBeenCalledWith(
      'search-inst-1',
      '/work',
      '/work',
      'rea',
      true
    )
    expect(result.current.loading).toBe(true)
    emitBatch({
      searchId: 'search-inst-1',
      files: [{ path: 'src/reader.ts', ignored: false }]
    })
    expect(result.current.sections).toHaveLength(1)
    expect(result.current.sections[0].items[0].label).toBe('reader.ts')
    emitDone({ searchId: 'search-inst-1', truncated: false, totalFiles: 1 })
    expect(result.current.loading).toBe(false)
    act(() => result.current.update('@', 1))
    expect(result.current.sections.map((s) => s.id)).toEqual(['categories'])
  })

  it('drops loading synchronously and logs when the stream start fails', async () => {
    mockApi.searchFileNamesStreamStart.mockResolvedValue({
      success: false as const,
      code: 'SEARCH_FILENAMES_STREAM_ERROR',
      error: 'boom'
    })
    const { result } = renderMentions()
    act(() => result.current.update('@rea', 4))
    await advance(90)
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(false)
    expect(result.current.sections).toHaveLength(0)
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'useComposerMentions',
        message: expect.stringContaining('SEARCH_FILENAMES_STREAM_ERROR')
      })
    )
  })

  it('drops loading and logs when done carries an error code (e.g. RG_SPAWN_FAILED)', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@rea', 4))
    await advance(90)
    emitBatch({
      searchId: 'search-inst-1',
      files: [{ path: 'src/auth.ts', ignored: false }]
    })
    expect(result.current.sections).toHaveLength(1)
    emitDone({
      searchId: 'search-inst-1',
      truncated: false,
      totalFiles: 1,
      code: 'RG_SPAWN_FAILED',
      error: 'rg missing'
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.sections).toHaveLength(0)
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'useComposerMentions',
        message: expect.stringContaining('RG_SPAWN_FAILED')
      })
    )
  })

  it('select splices a file token IN at the caret (no hoist), records the recent, and closes the menu', async () => {
    const { result, onStageFileRef } = renderMentions()
    act(() => result.current.update('@rea', 4))
    await advance(90)
    emitBatch({
      searchId: 'search-inst-1',
      files: [{ path: 'src/auth.ts', ignored: false }]
    })
    const picked = match('src/auth.ts')
    let outcome: { value: string; caret: number } | null = null
    act(() => {
      outcome = result.current.select('@rea', 4, { kind: 'file', match: picked })
    })
    // The @rea filter text is removed and a file token is spliced IN at the
    // caret (the token carries display + absPath split by the unit separator).
    // The caret lands after the token + trailing space.
    const expectedToken = fileToken('auth.ts', '/work/src/auth.ts')
    expect(outcome).toEqual({
      value: `${expectedToken} `,
      caret: expectedToken.length + 1
    })
    // onStageFileRef still fires (for recents), but the host no longer hoists.
    expect(onStageFileRef).toHaveBeenCalledWith(picked)
    expect(result.current.menuOpen).toBe(false)
  })

  it('cancels an in-flight stream on unmount', async () => {
    const { result, unmount } = renderMentions()
    act(() => result.current.update('@rea', 4))
    await advance(90)
    expect(result.current.loading).toBe(true)
    unmount()
    expect(mockApi.searchFileNamesStreamCancel).toHaveBeenCalledWith('search-inst-1')
  })

  it('uses instance-unique search ids so two hook instances never collide', async () => {
    // Distinct per-instance prefixes (randomUUID) keep the composer's
    // `search-<inst>-<n>` namespace disjoint from another hook instance and
    // from the file-explorer store's `search-<n>` namespace, so broadcast
    // batch/done events cannot update the wrong consumer.
    mockUuid.mockReturnValueOnce('a').mockReturnValueOnce('b')
    const first = renderMentions()
    act(() => first.result.current.update('@rea', 4))
    await advance(90)
    const firstSid = mockApi.searchFileNamesStreamStart.mock.calls[0][0] as string

    const second = renderMentions()
    act(() => second.result.current.update('@rea', 4))
    await advance(90)
    const secondSid = mockApi.searchFileNamesStreamStart.mock.calls[1][0] as string

    expect(firstSid).not.toBe(secondSid)
    expect(firstSid).toBe('search-a-1')
    expect(secondSid).toBe('search-b-1')
    // A batch for the first instance must not land in the second.
    emitBatch({ searchId: firstSid, files: [{ path: 'a.ts', ignored: false }] })
    expect(first.result.current.sections).toHaveLength(1)
    expect(second.result.current.sections).toHaveLength(0)
    first.unmount()
    second.unmount()
  })

  describe('drill-down panels (web: no recents, no query)', () => {
    const entry = (name: string, type: 'file' | 'directory', ignored?: boolean) => ({
      name,
      path: `/canonical/${name}`,
      type,
      extension: null,
      size: 0,
      modifiedAt: 0,
      ignored
    })

    beforeEach(() => {
      mockIsTauri.mockReturnValue(false)
      mockApi.readDirectory.mockImplementation(async (dir: string) => {
        if (dir === '/work') {
          return {
            success: true,
            data: [
              entry('src', 'directory'),
              entry('node_modules', 'directory', true),
              entry('README.md', 'file')
            ]
          }
        }
        if (dir === '/work/src') return { success: true, data: [entry('main.ts', 'file')] }
        return { success: false, error: 'EACCES: permission denied', code: 'FS_ERROR' }
      })
    })

    function pick(
      result: { current: ComposerMentions },
      state: { value: string; caret: number },
      row: MentionRow
    ) {
      act(() => {
        const out = result.current.select(state.value, state.caret, row)
        if (!out) throw new Error('select returned null')
        state.value = out.value
        state.caret = out.caret
        result.current.update(out.value, out.caret)
      })
    }

    const rows = (result: { current: ComposerMentions }) =>
      result.current.sections.flatMap((s) => s.items.map((i) => `${i.row.kind}:${i.label}`))

    function key(result: { current: ComposerMentions }, k: string): boolean {
      const event: ComposerKeyboardEvent = {
        key: k,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        defaultPrevented: false,
        nativeEvent: { isComposing: false },
        target: null,
        currentTarget: null,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      }
      let handled = false
      act(() => {
        const m = result.current
        handled = tryHandleMentionMenuKeyDown(event, {
          menuOpen: m.menuOpen,
          sectionsLength: m.sections.length,
          menuRef: m.menuRef,
          filter: m.filter,
          canGoBack: m.canGoBack,
          onBack: m.back,
          onReset: m.reset
        })
      })
      return handled
    }

    it('lists the root folder with no query, drills into a folder, and goes back', async () => {
      const { result } = renderMentions()
      const state = { value: 'see @', caret: 5 }
      act(() => result.current.update(state.value, state.caret))
      expect(rows(result)).toEqual(['category:Conversations', 'category:Explorer'])
      expect(result.current.view.header).toBeNull()

      pick(result, state, { kind: 'category', target: 'explorer' })
      await advance(0)
      expect(mockApi.readDirectory).toHaveBeenCalledWith('/work')
      expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()
      expect(result.current.view.header).toEqual({ title: 'Explorer', crumb: '' })
      expect(result.current.view.enter).toBe('forward')
      expect(rows(result)).toEqual(['dir:src', 'dir:node_modules', 'file:README.md'])
      expect(result.current.sections[0].items[1].ignored).toBe(true)

      const src = result.current.sections[0].items[0].row
      expect(src).toEqual({
        kind: 'dir',
        match: { relPath: 'src', absPath: '/work/src/', name: 'src', ignored: false, kind: 'dir' }
      })
      pick(result, state, src)
      await advance(0)
      expect(result.current.view.header).toEqual({ title: 'Explorer', crumb: 'src/' })
      expect(rows(result)).toEqual(['use-folder:Use this folder', 'file:main.ts'])
      expect(result.current.sections[1].items[0].row).toEqual({
        kind: 'file',
        match: {
          relPath: 'src/main.ts',
          absPath: '/work/src/main.ts',
          name: 'main.ts',
          ignored: false
        }
      })

      expect(key(result, 'ArrowLeft')).toBe(true)
      expect(result.current.view.enter).toBe('back')
      expect(rows(result)).toEqual(['dir:src', 'dir:node_modules', 'file:README.md'])
      expect(state.value).toBe('see @')
    })

    it('lists a project rooted at the filesystem root', async () => {
      mockApi.readDirectory.mockResolvedValue({ success: true, data: [entry('etc', 'directory')] })
      const { result } = renderMentions({ rootPath: '/' })
      const state = { value: '@', caret: 1 }
      act(() => result.current.update(state.value, state.caret))
      pick(result, state, { kind: 'category', target: 'explorer' })
      await advance(0)
      expect(mockApi.readDirectory).toHaveBeenCalledWith('/')
      expect(result.current.sections[0].items[0].row).toEqual({
        kind: 'dir',
        match: { relPath: 'etc', absPath: '/etc/', name: 'etc', ignored: false, kind: 'dir' }
      })
    })

    it('moves the caret with ArrowLeft while a query is typed instead of going back', async () => {
      const { result } = renderMentions()
      const state = { value: '@', caret: 1 }
      act(() => result.current.update(state.value, state.caret))
      pick(result, state, { kind: 'category', target: 'conversations' })
      act(() => result.current.update('@fix', 4))
      expect(key(result, 'ArrowLeft')).toBe(false)
      expect(result.current.view.header).toEqual({ title: 'Conversations', crumb: '' })
      act(() => result.current.update('@', 1))
      expect(key(result, 'ArrowLeft')).toBe(true)
      expect(result.current.view.header).toBeNull()
    })

    it('re-reads a folder on every visit, keeping the last listing on screen meanwhile', async () => {
      const { result } = renderMentions()
      const state = { value: '@', caret: 1 }
      act(() => result.current.update(state.value, state.caret))
      pick(result, state, { kind: 'category', target: 'explorer' })
      await advance(0)
      expect(rows(result)).toEqual(['dir:src', 'dir:node_modules', 'file:README.md'])

      mockApi.readDirectory.mockImplementation(async (dir: string) =>
        dir === '/work'
          ? { success: true, data: [entry('src', 'directory'), entry('NEW.md', 'file')] }
          : { success: true, data: [] }
      )
      pick(result, state, result.current.sections[0].items[0].row)
      await advance(0)
      act(() => result.current.back())
      expect(rows(result)).toEqual(['dir:src', 'dir:node_modules', 'file:README.md'])
      await advance(0)
      expect(rows(result)).toEqual(['dir:src', 'file:NEW.md'])
      expect(mockApi.readDirectory.mock.calls.map(([dir]) => dir)).toEqual([
        '/work',
        '/work/src',
        '/work'
      ])
    })

    it('keeps the newer listing when an earlier read of the same folder finishes last', async () => {
      let finishFirst!: (res: unknown) => void
      mockApi.readDirectory.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve
          })
      )
      const { result } = renderMentions()
      const state = { value: '@', caret: 1 }
      act(() => result.current.update(state.value, state.caret))
      pick(result, state, { kind: 'category', target: 'explorer' })
      pick(result, state, {
        kind: 'dir',
        match: { relPath: 'src', absPath: '/work/src/', name: 'src', ignored: false, kind: 'dir' }
      })
      await advance(0)
      act(() => result.current.back())
      await advance(0)
      expect(rows(result)).toEqual(['dir:src', 'dir:node_modules', 'file:README.md'])

      await act(async () => finishFirst({ success: true, data: [entry('OLD.md', 'file')] }))
      expect(rows(result)).toEqual(['dir:src', 'dir:node_modules', 'file:README.md'])
    })

    it('retries a folder that failed instead of showing the cached failure', async () => {
      const { result } = renderMentions()
      const state = { value: '@', caret: 1 }
      const secret: MentionRow = {
        kind: 'dir',
        match: {
          relPath: 'secret',
          absPath: '/work/secret/',
          name: 'secret',
          ignored: false,
          kind: 'dir'
        }
      }
      act(() => result.current.update(state.value, state.caret))
      pick(result, state, { kind: 'category', target: 'explorer' })
      pick(result, state, secret)
      await advance(0)
      expect(result.current.sections.find((s) => s.id === 'listing')?.notice).toBe(
        "Couldn't list this folder"
      )

      act(() => result.current.back())
      mockApi.readDirectory.mockResolvedValue({ success: true, data: [entry('key.pem', 'file')] })
      pick(result, state, secret)
      expect(result.current.sections.find((s) => s.id === 'listing')?.notice).toBe('Loading…')
      await advance(0)
      expect(rows(result)).toEqual(['use-folder:Use this folder', 'file:key.pem'])
    })

    it('clears the typed query when drilling in, and Backspace on the empty query goes back', async () => {
      const { result } = renderMentions()
      const state = { value: '@sr', caret: 3 }
      act(() => result.current.update(state.value, state.caret))
      pick(result, state, {
        kind: 'dir',
        match: { relPath: 'src', absPath: '/work/src/', name: 'src', ignored: false, kind: 'dir' }
      })
      await advance(0)
      expect(state).toEqual({ value: '@', caret: 1 })
      expect(result.current.filter).toBe('')
      expect(rows(result)).toEqual(['use-folder:Use this folder', 'file:main.ts'])

      expect(key(result, 'Backspace')).toBe(true)
      expect(rows(result)).toEqual(['category:Conversations', 'category:Explorer'])
      expect(result.current.canGoBack).toBe(false)
      expect(key(result, 'Backspace')).toBe(false)
    })

    it('shows an inline failure state and logs when a folder cannot be listed', async () => {
      const { result } = renderMentions()
      const state = { value: '@', caret: 1 }
      act(() => result.current.update(state.value, state.caret))
      pick(result, state, { kind: 'category', target: 'explorer' })
      await advance(0)
      pick(result, state, {
        kind: 'dir',
        match: {
          relPath: 'secret',
          absPath: '/work/secret/',
          name: 'secret',
          ignored: false,
          kind: 'dir'
        }
      })
      await advance(0)
      expect(result.current.sections.find((s) => s.id === 'listing')?.notice).toBe(
        "Couldn't list this folder"
      )
      expect(mockLog).toHaveBeenCalledWith({
        level: 'warn',
        message:
          'composer mention folder listing failed: dir=/work/secret code=FS_ERROR error=EACCES: permission denied',
        source: 'useComposerMentions'
      })
      expect(key(result, 'Escape')).toBe(true)
      expect(result.current.menuOpen).toBe(false)
    })

    it('starts back at the root when a new @ token opens', async () => {
      const { result } = renderMentions()
      const state = { value: '@', caret: 1 }
      act(() => result.current.update(state.value, state.caret))
      pick(result, state, { kind: 'category', target: 'explorer' })
      act(() => result.current.update('@ ', 2))
      expect(result.current.menuOpen).toBe(false)
      act(() => result.current.update('@ @', 3))
      expect(rows(result)).toEqual(['category:Conversations', 'category:Explorer'])
    })
  })

  describe('Conversations panel', () => {
    const entry = (
      id: string,
      title: string,
      lastActivityAt: number,
      extra: Partial<SessionIndexEntry> = {}
    ): SessionIndexEntry => ({
      id,
      agentId: 'agent',
      agentConfigId: 'claude-config',
      title,
      cwd: '/work',
      projectId: 'proj',
      createdAt: 0,
      lastActivityAt,
      messageCount: 1,
      status: 'idle',
      ...extra
    })

    beforeEach(() => {
      useAcpStore.setState({
        sessionIndex: [
          entry('old', 'Older chat', 10),
          entry('self', 'This chat', 50),
          entry('new', 'Fix web reconnect', 40),
          entry('other-project', 'Elsewhere', 60, { projectId: 'other' }),
          entry('found', 'Discovered', 70, { discovered: true })
        ],
        agentConfigs: [
          {
            id: 'claude-config',
            templateId: 'claude',
            name: 'Claude',
            command: 'claude',
            args: [],
            env: {}
          }
        ]
      })
    })

    const rows = (result: { current: ComposerMentions }) =>
      result.current.sections.flatMap((s) => s.items.map((i) => `${i.row.kind}:${i.label}`))

    it('counts project chats on the root, lists them newest first, and pills the pick', () => {
      const { result } = renderMentions()
      act(() => result.current.update('ask @', 5))
      expect(result.current.sections[0].items[0].description).toBe('2 in this project')

      let out: { value: string; caret: number } | null = null
      act(() => {
        out = result.current.select('ask @', 5, { kind: 'category', target: 'conversations' })
        if (out) result.current.update(out.value, out.caret)
      })
      expect(result.current.view.header).toEqual({ title: 'Conversations', crumb: '' })
      expect(rows(result)).toEqual(['conversation:Fix web reconnect', 'conversation:Older chat'])
      expect(result.current.sections[0].items[0].row).toEqual({
        kind: 'conversation',
        conversation: {
          sessionId: 'new',
          title: 'Fix web reconnect',
          agentName: 'Claude',
          lastActivityAt: 40,
          running: false
        }
      })

      act(() => result.current.update('ask @fix', 8))
      expect(rows(result)).toEqual(['conversation:Fix web reconnect'])
      expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()

      const pick = result.current.sections[0].items[0].row
      act(() => {
        out = result.current.select('ask @fix', 8, pick)
      })
      const token = conversationToken('Fix web reconnect', 'new')
      expect(out).toEqual({ value: `ask ${token} `, caret: 4 + token.length + 1 })
      expect(result.current.menuOpen).toBe(false)
      expect(mockLog).toHaveBeenCalledWith({
        level: 'info',
        message: 'composer mention picked conversation new…',
        source: 'useComposerMentions'
      })
    })

    it('shows matching chats above file results when typing at the root', async () => {
      const { result } = renderMentions()
      act(() => result.current.update('@older', 6))
      expect(rows(result)).toEqual(['conversation:Older chat'])
      await advance(90)
      emitBatch({ searchId: 'search-inst-1', files: [{ path: 'older.ts', ignored: false }] })
      expect(result.current.sections.map((s) => s.heading)).toEqual(['Conversations', 'Files'])
    })
  })
})
