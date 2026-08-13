import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionMatch } from './mention-menu-model'
import { useComposerMentions } from './use-composer-mentions'

const { mockApi, batchCbs, doneCbs, mockIsTauri, mockLog, mockUuid } = vi.hoisted(() => {
  const batch: Array<(e: never) => void> = []
  const done: Array<(e: never) => void> = []
  return {
    batchCbs: batch,
    doneCbs: done,
    mockApi: {
      searchFileNamesStreamStart: vi.fn(),
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
  files: Array<{ path: string; ignored: boolean }>
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
      false
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
    expect(items[0].payload.absPath).toBe('/work/src/auth.ts')
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

  it('fires no search on a bare @ (empty filter) and renders Recents', () => {
    const { result } = renderMentions({
      recents: [match('src/recent.ts'), match('README.md')]
    })
    act(() => result.current.update('@', 1))
    expect(result.current.menuOpen).toBe(true)
    expect(result.current.filter).toBe('')
    expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
    expect(result.current.sections).toHaveLength(1)
    expect(result.current.sections[0].id).toBe('recents')
    expect(result.current.sections[0].items).toHaveLength(2)
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
      false
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
      false
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
      false
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

  it('skips search entirely on web (!isTauriContext) and shows Recents', async () => {
    mockIsTauri.mockReturnValue(false)
    const { result } = renderMentions({
      recents: [match('src/recent.ts')]
    })
    // No subscription attempted on web.
    expect(mockApi.onSearchFileNamesBatch).not.toHaveBeenCalled()
    expect(mockApi.onSearchFileNamesDone).not.toHaveBeenCalled()
    act(() => result.current.update('@rea', 4))
    await advance(90)
    expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
    // Bare @ still shows recents on web.
    act(() => result.current.update('@', 1))
    expect(result.current.sections).toHaveLength(1)
    expect(result.current.sections[0].id).toBe('recents')
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

  it('select splices the @token, stages the file-ref, and closes the menu', async () => {
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
      outcome = result.current.select('@rea', 4, picked)
    })
    expect(outcome).toEqual({ value: '', caret: 0 })
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
})
