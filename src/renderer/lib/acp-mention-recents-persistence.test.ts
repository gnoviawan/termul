import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionMatch } from '@/components/chat/mention-menu-model'
import { STORE_VALUE_MAX_BYTES, storedValueBytes } from '@/lib/persistence-trim'
import {
  compositeKey,
  fromStoredRecent,
  loadMentionRecents,
  MENTION_RECENTS_CAP,
  mentionRecentsKey,
  pushRecent,
  type StoredRecent,
  saveMentionRecents,
  toStoredRecent
} from './acp-mention-recents-persistence'

const { mockPersistence } = vi.hoisted(() => ({
  mockPersistence: {
    read: vi.fn(),
    write: vi.fn<
      (key: string, value: StoredRecent[]) => Promise<{ success: true; data: undefined }>
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

  it('mentionRecentsKey encodes the partition safely', () => {
    expect(mentionRecentsKey('p1', '/work')).toBe(
      `acp/mention-recents/${encodeURIComponent('p1\u0000/work')}`
    )
  })

  it('round-trips a MentionMatch through stored form', () => {
    const stored = toStoredRecent(match('src/auth.ts', true))
    expect(stored).toEqual({ relPath: 'src/auth.ts', name: 'auth.ts', ignored: true })
    expect(fromStoredRecent(stored, '/work')).toEqual(match('src/auth.ts', true))
  })

  it('round-trips a folder recent with kind and a trailing-slash absPath', () => {
    const dir: MentionMatch = {
      relPath: 'src/components',
      absPath: '/work/src/components/',
      name: 'components',
      ignored: false,
      kind: 'dir'
    }
    const stored = toStoredRecent(dir)
    expect(stored).toEqual({
      relPath: 'src/components',
      name: 'components',
      ignored: false,
      kind: 'dir'
    })
    expect(fromStoredRecent(stored, '/work')).toEqual(dir)
  })

  it('treats a stored record without kind as a file (old persisted recents)', () => {
    const restored = fromStoredRecent({ relPath: 'a/b.ts', name: 'b.ts', ignored: false }, '/work')
    expect(restored.kind).toBeUndefined()
    expect(restored.absPath).toBe('/work/a/b.ts')
  })

  it('pushRecent keeps a file and a folder with the same relPath as separate entries', () => {
    const dir: MentionMatch = { ...match('src/search'), absPath: '/work/src/search/', kind: 'dir' }
    const next = pushRecent([match('src/search')], dir)
    expect(next).toHaveLength(2)
    expect(pushRecent(next, dir)).toHaveLength(2)
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

  it('loads recents for the active partition from its per-partition key', async () => {
    mockPersistence.read.mockResolvedValue({
      success: true,
      data: [{ relPath: 'src/a.ts', name: 'a.ts', ignored: false }]
    })
    const loaded = await loadMentionRecents('p1', '/work')
    expect(loaded).toEqual([match('src/a.ts')])
    expect(mockPersistence.read).toHaveBeenCalledWith(mentionRecentsKey('p1', '/work'))
  })

  it('returns [] when the read fails (non-missing)', async () => {
    mockPersistence.read.mockResolvedValue({ success: false, error: 'boom', code: 'READ_ERROR' })
    expect(await loadMentionRecents('p1', '/work')).toEqual([])
    // No legacy fallback attempted for a non-KEY_NOT_FOUND failure.
    expect(mockPersistence.read).toHaveBeenCalledTimes(1)
  })

  it('falls back to the legacy single-map layout on first miss', async () => {
    mockPersistence.read
      .mockResolvedValueOnce({ success: false, code: 'KEY_NOT_FOUND' }) // per-key miss
      .mockResolvedValueOnce({
        success: true,
        data: {
          [compositeKey('p1', '/work')]: [{ relPath: 'src/a.ts', name: 'a.ts', ignored: false }]
        }
      })
    const loaded = await loadMentionRecents('p1', '/work')
    expect(loaded).toEqual([match('src/a.ts')])
  })

  it('returns [] when neither per-key nor legacy has the partition', async () => {
    mockPersistence.read
      .mockResolvedValueOnce({ success: false, code: 'KEY_NOT_FOUND' }) // per-key miss
      .mockResolvedValueOnce({ success: true, data: {} }) // legacy map empty
    expect(await loadMentionRecents('p1', '/work')).toEqual([])
  })

  it('saves recents under the per-partition key without a read (no race)', async () => {
    await saveMentionRecents('p1', '/work', [match('src/a.ts', true)])
    expect(mockPersistence.read).not.toHaveBeenCalled()
    expect(mockPersistence.write).toHaveBeenCalledTimes(1)
    const [key, value] = mockPersistence.write.mock.calls[0]
    expect(key).toBe(mentionRecentsKey('p1', '/work'))
    expect(value).toEqual([{ relPath: 'src/a.ts', name: 'a.ts', ignored: true }])
  })

  it('concurrent saves for different partitions do not clobber each other', async () => {
    await Promise.all([
      saveMentionRecents('p1', '/work', [match('a.ts')]),
      saveMentionRecents('p2', '/other', [match('b.ts')])
    ])
    expect(mockPersistence.write).toHaveBeenCalledTimes(2)
    const keys = mockPersistence.write.mock.calls.map((c) => c[0])
    expect(keys).toContain(mentionRecentsKey('p1', '/work'))
    expect(keys).toContain(mentionRecentsKey('p2', '/other'))
    const values = mockPersistence.write.mock.calls.map((c) => c[1])
    expect(values[0]).toEqual([{ relPath: 'a.ts', name: 'a.ts', ignored: false }])
    expect(values[1]).toEqual([{ relPath: 'b.ts', name: 'b.ts', ignored: false }])
  })

  describe('value cap', () => {
    // Each recent stores its path twice (relPath and name): twenty of these are about
    // 320 KB, over the 256 KiB cap.
    const longRecents = (count: number): MentionMatch[] =>
      Array.from({ length: count }, (_, i) => match(`${i}-${'x'.repeat(8_000)}`))

    it('saves recents that fit the cap untouched', async () => {
      const recents = longRecents(10)
      await saveMentionRecents('p1', '/work', recents)
      const [, value] = mockPersistence.write.mock.calls[0]
      expect(value).toHaveLength(10)
    })

    it('drops the oldest recents (the end of the list) that do not fit', async () => {
      const recents = longRecents(MENTION_RECENTS_CAP)
      expect(storedValueBytes(recents.map(toStoredRecent))).toBeGreaterThan(STORE_VALUE_MAX_BYTES)

      await saveMentionRecents('p1', '/work', recents)

      const [, value] = mockPersistence.write.mock.calls[0]
      expect(storedValueBytes(value)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
      expect(value.length).toBeLessThan(MENTION_RECENTS_CAP)
      // The newest recents (the front of the list) are the ones kept.
      expect(value).toEqual(recents.slice(0, value.length).map(toStoredRecent))
      // One more would not have fit.
      const oneMore = recents.slice(0, value.length + 1).map(toStoredRecent)
      expect(storedValueBytes(oneMore)).toBeGreaterThan(STORE_VALUE_MAX_BYTES)
    })
  })
})
