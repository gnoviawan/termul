import type { SearchFileHit } from '@shared/types/ipc.types'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionMatch } from './mention-menu-model'
import { useComposerMentions } from './use-composer-mentions'

let batchCb:
  | ((event: { searchId: string; files: SearchFileHit[]; truncated?: boolean }) => void)
  | null = null
let doneCb:
  | ((event: {
      searchId: string
      truncated: boolean
      totalFiles: number
      code?: string
      error?: string
    }) => void)
  | null = null

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    searchFileNamesStreamStart: vi.fn<
      (
        searchId: string,
        scopeRoot: string,
        rootPath: string,
        query: string,
        includeIgnored?: boolean
      ) => Promise<{ success: true; data: undefined }>
    >(async () => ({ success: true as const, data: undefined })),
    searchFileNamesStreamCancel: vi.fn(async () => ({ success: true as const, data: undefined })),
    onSearchFileNamesBatch: vi.fn((cb: typeof batchCb) => {
      batchCb = cb
      return () => {}
    }),
    onSearchFileNamesDone: vi.fn((cb: typeof doneCb) => {
      doneCb = cb
      return () => {}
    })
  }
}))

vi.mock('@/lib/api', () => ({ filesystemApi: mockApi }))

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
      scopeRoot: '/work',
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
    mockApi.searchFileNamesStreamStart.mockClear()
    mockApi.searchFileNamesStreamCancel.mockClear()
    batchCb = null
    doneCb = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the menu and streams with includeIgnored=true on a non-empty @filter', () => {
    const { result } = renderMentions()
    act(() => result.current.update('@auth', 5))
    expect(result.current.menuOpen).toBe(true)
    expect(result.current.filter).toBe('auth')

    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(mockApi.searchFileNamesStreamStart).toHaveBeenCalledTimes(1)
    const args = mockApi.searchFileNamesStreamStart.mock.calls[0]
    expect(args[0]).toBe('mention-1')
    expect(args[1]).toBe('/work') // scopeRoot
    expect(args[2]).toBe('/work') // rootPath
    expect(args[3]).toBe('auth') // query
    expect(args[4]).toBe(true) // includeIgnored
  })

  it('does not open on plain text with no @', () => {
    const { result } = renderMentions()
    act(() => result.current.update('no mention here', 15))
    expect(result.current.menuOpen).toBe(false)
    expect(result.current.filter).toBe('')
    act(() => vi.advanceTimersByTime(120))
    expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()
  })

  it('shows recents (no stream) on a bare @ with empty filter', () => {
    const { result } = renderMentions({
      recents: [match('src/recent.ts'), match('README.md')]
    })
    act(() => result.current.update('@', 1))
    expect(result.current.menuOpen).toBe(true)
    expect(result.current.filter).toBe('')
    act(() => vi.advanceTimersByTime(120))
    expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()
    expect(result.current.sections).toHaveLength(1)
    expect(result.current.sections[0].id).toBe('recents')
    expect(result.current.sections[0].items).toHaveLength(2)
  })

  it('select splices the @token, stages the file-ref, and closes the menu', () => {
    const { result, onStageFileRef } = renderMentions()
    act(() => result.current.update('@auth', 5))
    const picked = match('src/auth.ts')
    let outcome: { value: string; caret: number } | null = null
    act(() => {
      outcome = result.current.select('@auth', 5, picked)
    })
    expect(outcome).toEqual({ value: '', caret: 0 })
    expect(onStageFileRef).toHaveBeenCalledWith(picked)
    expect(result.current.menuOpen).toBe(false)
  })

  it('select preserves surrounding text', () => {
    const { result, onStageFileRef } = renderMentions()
    act(() => result.current.update('hello @auth', 11))
    const picked = match('src/auth.ts')
    let outcome: { value: string; caret: number } | null = null
    act(() => {
      outcome = result.current.select('hello @auth', 11, picked)
    })
    expect(outcome).toEqual({ value: 'hello ', caret: 6 })
    expect(onStageFileRef).toHaveBeenCalled()
  })

  it('populates matches from a batch event and builds Files sections', () => {
    const { result } = renderMentions()
    act(() => result.current.update('@auth', 5))
    act(() => vi.advanceTimersByTime(120))
    expect(batchCb).not.toBeNull()
    act(() => {
      batchCb!({
        searchId: 'mention-1',
        files: [
          { path: 'src/auth.ts', ignored: false },
          { path: 'node_modules/auth/index.js', ignored: true }
        ],
        truncated: false
      })
    })
    const sections = result.current.sections
    expect(sections).toHaveLength(1)
    expect(sections[0].id).toBe('files')
    expect(sections[0].items).toHaveLength(2)
    expect(sections[0].items[0].label).toBe('auth.ts')
    expect(sections[0].items[0].ignored).toBe(false)
    expect(sections[0].items[1].ignored).toBe(true)
  })

  it('ignores a batch event for a stale search id', () => {
    const { result } = renderMentions()
    act(() => result.current.update('@auth', 5))
    act(() => vi.advanceTimersByTime(120))
    act(() => {
      batchCb!({
        searchId: 'mention-stale',
        files: [{ path: 'src/auth.ts', ignored: false }],
        truncated: false
      })
    })
    expect(result.current.sections).toEqual([])
  })

  it('does not stream when disabled', () => {
    const { result } = renderMentions({ disabled: true })
    act(() => result.current.update('@auth', 5))
    // menuOpen follows the token, but the stream effect is gated on disabled.
    act(() => vi.advanceTimersByTime(120))
    expect(mockApi.searchFileNamesStreamStart).not.toHaveBeenCalled()
  })
})
