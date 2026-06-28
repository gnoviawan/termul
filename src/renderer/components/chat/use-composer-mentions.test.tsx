import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionMatch } from './mention-menu-model'
import { __resetMentionFileCache, useComposerMentions } from './use-composer-mentions'

const { mockReadDir, mockChangeCb, mockApi } = vi.hoisted(() => {
  const changeCb = { current: null as null | ((event: { path: string }) => void) }
  return {
    mockReadDir: vi.fn(),
    mockChangeCb: changeCb,
    mockApi: {
      onFileChanged: vi.fn((cb: (event: { path: string }) => void) => {
        changeCb.current = cb
        return () => {}
      }),
      onFileCreated: vi.fn(() => () => {}),
      onFileDeleted: vi.fn(() => () => {})
    }
  }
})

vi.mock('@tauri-apps/plugin-fs', () => ({ readDir: mockReadDir }))
vi.mock('@/lib/api', () => ({ filesystemApi: mockApi }))

// Minimal fake project tree. `node_modules` is present at the root to verify
// the walk skips it (never enqueued, so readDir is never called for it).
const TREE: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
  '/work': [
    { name: 'src', isDirectory: true },
    { name: 'a.ts', isDirectory: false },
    { name: 'node_modules', isDirectory: true }
  ],
  '/work/src': [
    { name: 'auth.ts', isDirectory: false },
    { name: 'chat', isDirectory: true }
  ],
  '/work/src/chat': [{ name: 'ChatInputBar.tsx', isDirectory: false }]
}

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
    mockReadDir.mockReset()
    mockReadDir.mockImplementation(async (dir: string) => TREE[dir] ?? [])
    mockApi.onFileChanged.mockClear()
    mockApi.onFileCreated.mockClear()
    mockApi.onFileDeleted.mockClear()
    mockChangeCb.current = null
    __resetMentionFileCache()
  })

  it('walks the project tree and filters by basename on a non-empty @filter', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@auth', 5))
    expect(result.current.menuOpen).toBe(true)
    expect(result.current.filter).toBe('auth')
    await waitFor(() => expect(result.current.sections).toHaveLength(1))
    const items = result.current.sections[0].items
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('auth.ts')
    expect(items[0].description).toBe('src/auth.ts')
  })

  it('skips commonly-ignored directories during the walk', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@auth', 5))
    await waitFor(() => expect(result.current.sections).toHaveLength(1))
    // node_modules is listed under /work but must never be walked into.
    expect(mockReadDir).not.toHaveBeenCalledWith('/work/node_modules')
  })

  it('shows recents on a bare @ with empty filter', () => {
    const { result } = renderMentions({
      recents: [match('src/recent.ts'), match('README.md')]
    })
    act(() => result.current.update('@', 1))
    expect(result.current.menuOpen).toBe(true)
    expect(result.current.sections).toHaveLength(1)
    expect(result.current.sections[0].id).toBe('recents')
    expect(result.current.sections[0].items).toHaveLength(2)
  })

  it('does not walk when disabled', () => {
    const { result } = renderMentions({ disabled: true })
    act(() => result.current.update('@auth', 5))
    expect(mockReadDir).not.toHaveBeenCalled()
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

  it('reuses the cache on a second menu open (no re-walk)', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@auth', 5))
    await waitFor(() => expect(result.current.sections).toHaveLength(1))
    const callsAfterFirst = mockReadDir.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    act(() => result.current.reset())
    act(() => result.current.update('@chat', 5))
    await waitFor(() => expect(result.current.sections).toHaveLength(1))
    expect(mockReadDir.mock.calls.length).toBe(callsAfterFirst)
    const items = result.current.sections[0].items
    expect(items.some((i) => i.label === 'ChatInputBar.tsx')).toBe(true)
  })

  it('re-walks after a file-change invalidation', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@auth', 5))
    await waitFor(() => expect(result.current.sections).toHaveLength(1))
    const callsAfterFirst = mockReadDir.mock.calls.length

    act(() => mockChangeCb.current?.({ path: '/work/new.ts' }))
    act(() => result.current.update('@auth', 5))
    await waitFor(() => expect(mockReadDir.mock.calls.length).toBeGreaterThan(callsAfterFirst))
  })

  it('ignores file-change events outside the project root', async () => {
    const { result } = renderMentions()
    act(() => result.current.update('@auth', 5))
    await waitFor(() => expect(result.current.sections).toHaveLength(1))
    const callsAfterFirst = mockReadDir.mock.calls.length

    act(() => mockChangeCb.current?.({ path: '/other/x.ts' }))
    act(() => result.current.update('@auth', 5))
    // Event was outside /work, so the cache stays warm and no re-walk happens.
    expect(mockReadDir.mock.calls.length).toBe(callsAfterFirst)
  })

  it('re-walks when a change lands during an in-flight walk', async () => {
    let resolveFirst: () => void = () => {}
    mockReadDir.mockReset()
    mockReadDir.mockImplementationOnce(
      () =>
        new Promise<Array<{ name: string; isDirectory: boolean }>>((resolve) => {
          resolveFirst = () => resolve(TREE['/work'] ?? [])
        })
    )
    mockReadDir.mockImplementation(async (dir: string) => TREE[dir] ?? [])

    const { result } = renderMentions()
    act(() => result.current.update('@auth', 5))
    // Walk is in flight (readDir for /work pending). Fire a change under /work
    // before it resolves — the result is stale and must be discarded.
    act(() => mockChangeCb.current?.({ path: '/work/new.ts' }))
    act(() => resolveFirst())
    await waitFor(() => expect(result.current.sections).toHaveLength(1))
    const workCalls = mockReadDir.mock.calls.filter((c) => c[0] === '/work').length
    expect(workCalls).toBeGreaterThanOrEqual(2)
  })
})
