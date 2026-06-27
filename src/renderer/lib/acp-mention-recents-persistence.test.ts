import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionMatch } from '@/components/chat/mention-menu-model'
import {
  ACP_MENTION_RECENTS_KEY,
  compositeKey,
  fromStoredRecent,
  loadMentionRecents,
  MENTION_RECENTS_CAP,
  pushRecent,
  type StoredRecent,
  saveMentionRecents,
  toStoredRecent
} from './acp-mention-recents-persistence'

const { mockPersistence } = vi.hoisted(() => ({
  mockPersistence: {
    read: vi.fn(),
    write: vi.fn<
      (
        key: string,
        value: Record<string, StoredRecent[]>
      ) => Promise<{
        success: true
        data: undefined
      }>
    >(async () => ({ success: true as const, data: undefined }))
  }
}))

vi.mock('@/lib/api', () => ({ persistenceApi: mockPersistence }))

const match = (relPath: string, ignored = false): MentionMatch => ({
  relPath,
  absPath: `/work/${relPath}`,
  name: relPath.split('/').pop() ?? relPath,
  ignored
})

describe('mention recents — pure helpers', () => {
  it('compositeKey isolates project + cwd', () => {
    expect(compositeKey('p1', '/work')).toBe('p1\u0000/work')
    expect(compositeKey('p1', '/work')).not.toBe(compositeKey('p1', '/work/sub'))
    expect(compositeKey('p1', '/work')).not.toBe(compositeKey('p2', '/work'))
  })

  it('round-trips a MentionMatch through stored form', () => {
    const stored = toStoredRecent(match('src/auth.ts', true))
    expect(stored).toEqual({ relPath: 'src/auth.ts', name: 'auth.ts', ignored: true })
    expect(fromStoredRecent(stored, '/work')).toEqual(match('src/auth.ts', true))
  })

  it('pushRecent moves the match to front, dedups by relPath, and caps', () => {
    const list = [match('a.ts'), match('b.ts')]
    const next = pushRecent(list, match('b.ts'))
    expect(next.map((m) => m.relPath)).toEqual(['b.ts', 'a.ts'])

    const capped = pushRecent(
      Array.from({ length: MENTION_RECENTS_CAP }, (_, i) => match(`f${i}.ts`)),
      match('new.ts')
    )
    expect(capped).toHaveLength(MENTION_RECENTS_CAP)
    expect(capped[0].relPath).toBe('new.ts')
  })
})

describe('mention recents — persistence', () => {
  beforeEach(() => {
    mockPersistence.read.mockReset()
    mockPersistence.write.mockReset()
    mockPersistence.write.mockResolvedValue({ success: true as const, data: undefined })
  })

  it('loads recents for the active (projectId, cwd) and rebuilds absPath', async () => {
    mockPersistence.read.mockResolvedValue({
      success: true,
      data: {
        [compositeKey('p1', '/work')]: [{ relPath: 'src/a.ts', name: 'a.ts', ignored: false }]
      }
    })
    const loaded = await loadMentionRecents('p1', '/work')
    expect(loaded).toEqual([match('src/a.ts')])
  })

  it('returns [] when there is no entry for the partition', async () => {
    mockPersistence.read.mockResolvedValue({ success: true, data: {} })
    expect(await loadMentionRecents('p1', '/work')).toEqual([])
  })

  it('returns [] when the read fails', async () => {
    mockPersistence.read.mockResolvedValue({ success: false, error: 'boom' })
    expect(await loadMentionRecents('p1', '/work')).toEqual([])
  })

  it('saves recents under the composite key without clobbering other partitions', async () => {
    const otherKey = compositeKey('p2', '/other')
    mockPersistence.read.mockResolvedValue({
      success: true,
      data: { [otherKey]: [{ relPath: 'x.ts', name: 'x.ts', ignored: false }] }
    })
    await saveMentionRecents('p1', '/work', [match('src/a.ts', true)])
    expect(mockPersistence.write).toHaveBeenCalledTimes(1)
    const [key, value] = mockPersistence.write.mock.calls[0]
    expect(key).toBe(ACP_MENTION_RECENTS_KEY)
    expect(value[compositeKey('p1', '/work')]).toEqual([
      { relPath: 'src/a.ts', name: 'a.ts', ignored: true }
    ])
    expect(value[otherKey]).toHaveLength(1)
  })
})
