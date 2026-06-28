import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionMatch } from '@/components/chat/mention-menu-model'
import {
  ACP_MENTION_RECENTS_KEY,
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
      `${ACP_MENTION_RECENTS_KEY}/${encodeURIComponent('p1\u0000/work')}`
    )
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
})
