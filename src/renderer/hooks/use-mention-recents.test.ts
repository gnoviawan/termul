import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionMatch } from '@/components/chat/mention-menu-model'
import { useMentionRecents } from './use-mention-recents'

const match = (relPath: string, ignored = false): MentionMatch => ({
  relPath,
  absPath: `/work/${relPath}`,
  name: relPath.split('/').pop() ?? relPath,
  ignored
})

const { loadMock, saveMock } = vi.hoisted(() => ({
  loadMock: vi.fn(async (): Promise<MentionMatch[]> => []),
  saveMock: vi.fn(async (): Promise<void> => {})
}))

vi.mock('@/lib/acp-mention-recents-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/acp-mention-recents-persistence')>()
  return { ...actual, loadMentionRecents: loadMock, saveMentionRecents: saveMock }
})

describe('useMentionRecents', () => {
  beforeEach(() => {
    loadMock.mockReset()
    saveMock.mockReset()
  })

  it('loads recents for the active (projectId, cwd) on mount', async () => {
    loadMock.mockResolvedValue([match('src/a.ts')])
    const { result } = renderHook(() => useMentionRecents('p1', '/work'))
    await act(() => Promise.resolve())
    expect(loadMock).toHaveBeenCalledWith('p1', '/work')
    expect(result.current.recents).toEqual([match('src/a.ts')])
  })

  it('pushRecent updates state, dedups, and persists', async () => {
    loadMock.mockResolvedValue([match('src/a.ts')])
    const { result } = renderHook(() => useMentionRecents('p1', '/work'))
    await act(() => Promise.resolve())
    act(() => result.current.pushRecent(match('src/a.ts')))
    expect(result.current.recents.map((m) => m.relPath)).toEqual(['src/a.ts'])
    act(() => result.current.pushRecent(match('src/b.ts')))
    expect(result.current.recents.map((m) => m.relPath)).toEqual(['src/b.ts', 'src/a.ts'])
    expect(saveMock).toHaveBeenCalledTimes(2)
    expect(saveMock).toHaveBeenLastCalledWith('p1', '/work', [
      expect.objectContaining({ relPath: 'src/b.ts' }),
      expect.objectContaining({ relPath: 'src/a.ts' })
    ])
  })

  it('clears recents when projectId or cwd is missing', () => {
    const { result } = renderHook(() => useMentionRecents(undefined, '/work'))
    expect(result.current.recents).toEqual([])
    expect(loadMock).not.toHaveBeenCalled()
  })
})
