import type { SessionData } from '@shared/types/ipc.types'
import type {
  PersistedSnapshot,
  PersistedSnapshotList,
  PersistedTerminal,
  PersistedTerminalLayout
} from '@shared/types/persistence.types'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAddCommand } from '@/hooks/use-command-history'
import { useCommandHistoryStore } from '@/stores/command-history-store'
import {
  jsonBytes,
  STORE_VALUE_MAX_BYTES,
  storedValueBytes,
  trimListToCap,
  trimSessionData,
  trimSnapshotList,
  trimTerminalLayout
} from '../persistence-trim'

const { mockWrite } = vi.hoisted(() => ({
  mockWrite: vi.fn(async () => ({ success: true as const, data: undefined }))
}))

vi.mock('@/lib/api', () => ({ persistenceApi: { write: mockWrite } }))

function terminal(id: string, lines: number, transcriptLines: number): PersistedTerminal {
  return {
    id,
    name: `Terminal ${id}`,
    shell: 'bash',
    cwd: '/work',
    scrollback: Array.from(
      { length: lines },
      (_, i) => `${id} line ${String(i).padStart(5, '0')} ${'.'.repeat(80)}`
    ),
    transcript: Array.from(
      { length: transcriptLines },
      (_, i) => `${id}-t${String(i).padStart(6, '0')}\n`
    ).join('')
  }
}

function layout(terminals: PersistedTerminal[]): PersistedTerminalLayout {
  return {
    activeTerminalId: terminals[0]?.id ?? null,
    terminals,
    updatedAt: '2026-01-01T00:00:00Z'
  }
}

function snapshot(id: string, terminals: PersistedTerminal[], name = id): PersistedSnapshot {
  return {
    id,
    projectId: 'p1',
    name,
    createdAt: '2026-01-01T00:00:00Z',
    terminals,
    activeTerminalId: terminals[0]?.id ?? null
  }
}

function snapshotList(snapshots: PersistedSnapshot[]): PersistedSnapshotList {
  return { snapshots, updatedAt: '2026-01-01T00:00:00Z' }
}

const outputChars = (t: PersistedTerminal): number =>
  (t.scrollback?.join('').length ?? 0) + (t.transcript?.length ?? 0)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('storedValueBytes', () => {
  it('counts the UTF-8 bytes of the wrapped value the host sees', () => {
    const data = { text: 'aé€😀', list: [1, 2, 3] }
    const wrapped = JSON.stringify({ _version: 1, data })
    expect(storedValueBytes(data)).toBe(new TextEncoder().encode(wrapped).length)
    expect(jsonBytes('😀')).toBe(6) // quotes + one 4-byte scalar
  })
})

describe('the cap on every surface', () => {
  it('trims a value over the host cap, desktop included', () => {
    const huge = layout([terminal('a', 4000, 4000)])
    expect(storedValueBytes(huge)).toBeGreaterThan(STORE_VALUE_MAX_BYTES)

    const trimmed = trimTerminalLayout(huge)
    expect(trimmed).not.toBe(huge)
    expect(storedValueBytes(trimmed)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
    const items = ['x'.repeat(STORE_VALUE_MAX_BYTES + 1)]
    expect(trimListToCap(items, (kept) => kept, 'head').items).not.toBe(items)
  })
})

describe('trimListToCap', () => {
  const items = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(100))
  const sizeOf = (n: number): number => storedValueBytes(items.slice(0, n))

  it('returns the same array when it already fits, exactly at the cap', () => {
    const result = trimListToCap(items, (kept) => kept, 'head', sizeOf(10))
    expect(result.items).toBe(items)
    expect(result.dropped).toBe(0)
  })

  it('drops the oldest entry when one byte over the cap (newest-first list keeps the head)', () => {
    const result = trimListToCap(items, (kept) => kept, 'head', sizeOf(10) - 1)
    expect(result.dropped).toBe(1)
    expect(result.items).toEqual(items.slice(0, 9))
  })

  it('keeps the tail of a chronological list', () => {
    const result = trimListToCap(items, (kept) => kept, 'tail', sizeOf(4))
    expect(result.items).toEqual(items.slice(6))
    expect(result.dropped).toBe(6)
  })

  it('never exceeds the cap and keeps as many entries as fit', () => {
    for (const keep of [0, 1, 4, 9]) {
      const cap = sizeOf(keep)
      const result = trimListToCap(items, (kept) => kept, 'head', cap)
      expect(result.items).toHaveLength(keep)
      expect(storedValueBytes(result.items)).toBeLessThanOrEqual(cap)
    }
  })

  it('measures the value `build` makes, not the bare list', () => {
    const capForFive = storedValueBytes({ entries: items.slice(0, 5), updatedAt: 'x' })
    const result = trimListToCap(
      items,
      (kept) => ({ entries: kept, updatedAt: 'x' }),
      'head',
      capForFive
    )
    expect(result.items).toHaveLength(5)
  })
})

describe('trimTerminalLayout', () => {
  const full = layout([terminal('a', 1500, 3000), terminal('b', 1500, 3000)])
  const fullBytes = storedValueBytes(full)

  it('fixture is over the host cap', () => {
    expect(fullBytes).toBeGreaterThan(STORE_VALUE_MAX_BYTES)
  })

  it('returns the very same layout when it fits, exactly at the cap', () => {
    expect(trimTerminalLayout(full, fullBytes)).toBe(full)
  })

  it('trims as little as needed when one byte over the cap', () => {
    const trimmed = trimTerminalLayout(full, fullBytes - 1)

    expect(storedValueBytes(trimmed)).toBeLessThanOrEqual(fullBytes - 1)
    const kept = trimmed.terminals.reduce((sum, t) => sum + outputChars(t), 0)
    const original = full.terminals.reduce((sum, t) => sum + outputChars(t), 0)
    expect(kept).toBeGreaterThan(original * 0.99)
    expect(kept).toBeLessThan(original)
  })

  it('keeps the newest scrollback lines and transcript tail of every terminal', () => {
    const trimmed = trimTerminalLayout(full, STORE_VALUE_MAX_BYTES)

    expect(storedValueBytes(trimmed)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
    for (const [i, original] of full.terminals.entries()) {
      const t = trimmed.terminals[i]
      const lines = t.scrollback ?? []
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.length).toBeLessThan(original.scrollback?.length ?? 0)
      // The kept lines are the end of the original, in order.
      expect(lines).toEqual(original.scrollback?.slice(-lines.length))
      const text = t.transcript ?? ''
      expect(text.length).toBeGreaterThan(0)
      expect(original.transcript?.endsWith(text)).toBe(true)
      // The cut falls on a line start: no half line at the head.
      expect(text.startsWith(`${original.id}-t`)).toBe(true)
    }
  })

  it('keeps every terminal and its metadata', () => {
    const trimmed = trimTerminalLayout(full, STORE_VALUE_MAX_BYTES)

    expect(trimmed.activeTerminalId).toBe(full.activeTerminalId)
    expect(trimmed.updatedAt).toBe(full.updatedAt)
    expect(trimmed.terminals.map(({ id, name, shell, cwd }) => ({ id, name, shell, cwd }))).toEqual(
      full.terminals.map(({ id, name, shell, cwd }) => ({ id, name, shell, cwd }))
    )
  })

  it('does not mutate its input', () => {
    const before = JSON.stringify(full)
    trimTerminalLayout(full, STORE_VALUE_MAX_BYTES)
    expect(JSON.stringify(full)).toBe(before)
  })

  it('never leaves half of a surrogate pair at the cut', () => {
    const emoji = layout([{ id: 'e', name: 'e', shell: 'bash', transcript: '😀'.repeat(200_000) }])

    const trimmed = trimTerminalLayout(emoji, STORE_VALUE_MAX_BYTES)

    const text = trimmed.terminals[0].transcript ?? ''
    expect(text.length).toBeGreaterThan(0)
    expect(text.isWellFormed()).toBe(true)
    expect(storedValueBytes(trimmed)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
  })

  it('drops all output (and still returns the layout) when the metadata alone is over the cap', () => {
    const heavy = layout([{ ...terminal('a', 10, 10), name: 'n'.repeat(STORE_VALUE_MAX_BYTES) }])

    const trimmed = trimTerminalLayout(heavy)

    expect(trimmed.terminals[0].scrollback).toBeUndefined()
    expect(trimmed.terminals[0].transcript).toBeUndefined()
    expect(trimmed.terminals[0].name).toBe(heavy.terminals[0].name)
  })
})

describe('trimSnapshotList', () => {
  // Each snapshot is ~100 KB of output: three of them are over the cap, two fit.
  const big = (id: string): PersistedSnapshot => snapshot(id, [terminal(id, 1050, 0)])
  const outputOf = (s: PersistedSnapshot): number =>
    s.terminals.reduce((sum, t) => sum + outputChars(t), 0)

  it('fixtures: two snapshots fit, three do not', () => {
    expect(storedValueBytes(snapshotList([big('a'), big('b')]))).toBeLessThanOrEqual(
      STORE_VALUE_MAX_BYTES
    )
    expect(storedValueBytes(snapshotList([big('a'), big('b'), big('c')]))).toBeGreaterThan(
      STORE_VALUE_MAX_BYTES
    )
  })

  it('returns the same list when it fits, exactly at the cap', () => {
    const list = snapshotList([big('a'), big('b')])
    const result = trimSnapshotList(list, storedValueBytes(list))
    expect(result.list).toBe(list)
    expect(result.shrunk).toBe(0)
    expect(result.droppedIds).toEqual([])
  })

  it('strips the output of the oldest snapshot first and keeps every snapshot (newest first order)', () => {
    const list = snapshotList([big('new'), big('mid'), big('old')])

    const result = trimSnapshotList(list)

    expect(storedValueBytes(result.list)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
    expect(result.list.snapshots.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
    expect(outputOf(result.list.snapshots[2])).toBe(0)
    expect(result.list.snapshots[2].terminals).toHaveLength(1)
    expect(result.list.snapshots[1]).toEqual(list.snapshots[1])
    expect(result.list.snapshots[0]).toEqual(list.snapshots[0])
    expect(result.shrunk).toBe(1)
    expect(result.droppedIds).toEqual([])
  })

  it('cuts the newest snapshot only after older snapshots lost their output', () => {
    const list = snapshotList([snapshot('new', [terminal('new', 4000, 0)]), big('mid'), big('old')])
    expect(outputOf(list.snapshots[0])).toBeGreaterThan(STORE_VALUE_MAX_BYTES / 2)

    const result = trimSnapshotList(list)

    expect(storedValueBytes(result.list)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
    const [newest, mid, old] = result.list.snapshots
    expect(outputOf(old)).toBe(0)
    expect(outputOf(mid)).toBe(0)
    const kept = newest.terminals[0].scrollback ?? []
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(4000)
    expect(kept).toEqual(list.snapshots[0].terminals[0].scrollback?.slice(-kept.length))
    expect(result.droppedIds).toEqual([])
  })

  it('cuts the newest snapshot alone as little as needed', () => {
    const single = snapshotList([snapshot('only', [terminal('only', 3000, 0)])])
    const bytes = storedValueBytes(single)

    const result = trimSnapshotList(single, bytes - 1)

    expect(storedValueBytes(result.list)).toBeLessThanOrEqual(bytes - 1)
    expect(outputOf(result.list.snapshots[0])).toBeGreaterThan(outputOf(single.snapshots[0]) * 0.99)
    expect(result.shrunk).toBe(1)
  })

  it('removes the oldest whole snapshots only when output cannot make room, oldest first', () => {
    const named = (id: string): PersistedSnapshot =>
      snapshot(id, [terminal(id, 10, 0)], `${id}-${'n'.repeat(100_000)}`)
    const list = snapshotList([named('new'), named('mid'), named('old')])

    const result = trimSnapshotList(list)

    expect(result.list.snapshots.map((s) => s.id)).toEqual(['new', 'mid'])
    expect(result.droppedIds).toEqual(['old'])
    expect(storedValueBytes(result.list)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
  })

  it('never removes the newest snapshot, even when it cannot fit alone', () => {
    const hopeless = snapshotList([snapshot('only', [], 'n'.repeat(STORE_VALUE_MAX_BYTES + 10))])

    const result = trimSnapshotList(hopeless)

    expect(result.list.snapshots.map((s) => s.id)).toEqual(['only'])
    expect(result.droppedIds).toEqual([])
  })

  it('does not mutate its input', () => {
    const list = snapshotList([big('new'), big('mid'), big('old')])
    const before = JSON.stringify(list)
    trimSnapshotList(list)
    expect(JSON.stringify(list)).toBe(before)
  })
})

describe('command history writer', () => {
  beforeEach(() => {
    useCommandHistoryStore.setState({ entries: [] })
  })

  const entry = (i: number, size: number) => ({
    id: `e${i}`,
    command: `${i}:${'x'.repeat(size)}`,
    terminalName: 'Terminal 1',
    terminalId: 't1',
    projectId: 'p1',
    timestamp: i
  })

  it('writes a short history as is', async () => {
    const { result } = renderHook(() => useAddCommand())

    await result.current('ls', 'Terminal 1', 't1', 'p1')

    expect(mockWrite).toHaveBeenCalledTimes(1)
    const [key, value] = mockWrite.mock.calls[0] as unknown as [string, { command: string }[]]
    expect(key).toBe('projects/p1/command-history')
    expect(value.map((e) => e.command)).toEqual(['ls'])
  })

  it('drops the oldest commands that do not fit and keeps the new one first', async () => {
    // 499 old commands of ~600 bytes are ~300 KB: over the cap before the new one.
    useCommandHistoryStore.setState({
      entries: Array.from({ length: 499 }, (_, i) => entry(499 - i, 600))
    })
    const { result } = renderHook(() => useAddCommand())

    await result.current('echo newest', 'Terminal 1', 't1', 'p1')

    const [, value] = mockWrite.mock.calls[0] as unknown as [string, { command: string }[]]
    expect(storedValueBytes(value)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
    expect(value[0].command).toBe('echo newest')
    expect(value.length).toBeLessThan(500)
    // The kept entries are the newest ones, in order.
    expect(value[1].command.startsWith('499:')).toBe(true)
    expect(value.at(-1)?.command.startsWith(`${499 - (value.length - 2)}:`)).toBe(true)
    // In memory nothing was dropped.
    expect(useCommandHistoryStore.getState().entries).toHaveLength(500)
  })
})

describe('trimSessionData', () => {
  const session = (lines: number): SessionData => ({
    timestamp: '2026-01-01T00:00:00Z',
    terminals: [
      {
        id: 't',
        shell: 'bash',
        cwd: '/',
        history: Array.from(
          { length: lines },
          (_, i) => `cmd ${String(i).padStart(6, '0')} ${'x'.repeat(80)}`
        )
      }
    ],
    workspaces: []
  })

  it('returns a session under the cap untouched', () => {
    const small = session(10)
    expect(trimSessionData(small)).toBe(small)
  })

  it('keeps the newest history lines and fits the cap when over it', () => {
    const big = session(6000)
    const trimmed = trimSessionData(big)
    expect(storedValueBytes(trimmed)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
    const history = trimmed.terminals[0].history
    expect(history.length).toBeGreaterThan(0)
    expect(history.length).toBeLessThan(6000)
    expect(history.at(-1)).toBe(big.terminals[0].history.at(-1))
  })
})
