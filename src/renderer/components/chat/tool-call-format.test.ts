import { describe, expect, it } from 'vitest'
import type { PermissionOption } from '@/lib/acp-api'
import {
  diffLineCounts,
  diffLines,
  isAllowOption,
  isRejectOption,
  kindIcon,
  pickPrimaryAllowOption,
  pickRejectOption,
  statusStyle
} from './tool-call-format'

describe('kindIcon', () => {
  it('maps known kinds', () => {
    expect(kindIcon('read')).toBe('read')
    expect(kindIcon('edit')).toBe('edit')
    expect(kindIcon('execute')).toBe('execute')
    expect(kindIcon('switch_mode')).toBe('switch')
  })
  it('falls back to a generic tool icon for unknown/undefined', () => {
    expect(kindIcon('frobnicate')).toBe('tool')
    expect(kindIcon(undefined)).toBe('tool')
  })
})

describe('statusStyle', () => {
  it('marks in_progress as spinning', () => {
    expect(statusStyle('in_progress').spinning).toBe(true)
  })
  it('completed/failed/pending are not spinning', () => {
    expect(statusStyle('completed').spinning).toBe(false)
    expect(statusStyle('failed').spinning).toBe(false)
    expect(statusStyle('pending').spinning).toBe(false)
    expect(statusStyle(undefined).label).toBe('pending')
  })
})

describe('diffLines / diffLineCounts', () => {
  it('computes actual changed lines between old and new file contents', () => {
    // oldText: a, b  →  newText: a, c
    // LCS: [a] → removed: [b], added: [c]
    const lines = diffLines({ oldText: 'a\nb', newText: 'a\nc' })
    const types = lines.map((l) => l.type)
    const texts = lines.map((l) => l.text)
    expect(types).toContain('removed')
    expect(types).toContain('added')
    expect(types).toContain('context')
    expect(texts).toContain('b')
    expect(texts).toContain('c')
    expect(diffLineCounts({ oldText: 'a\nb', newText: 'a\nc' })).toEqual({ added: 1, removed: 1 })
  })
  it('treats absent oldText as a new file (all lines added)', () => {
    const lines = diffLines({ oldText: null, newText: 'x\ny' })
    expect(lines.every((l) => l.type === 'added')).toBe(true)
    expect(diffLineCounts({ oldText: null, newText: 'x\ny' })).toEqual({ added: 2, removed: 0 })
  })
  it('treats empty newText as a full deletion', () => {
    const lines = diffLines({ oldText: 'a', newText: '' })
    expect(lines).toEqual([{ type: 'removed', text: 'a', oldLine: 1 }])
    expect(diffLineCounts({ oldText: 'a', newText: '' })).toEqual({ added: 0, removed: 1 })
  })
  it('strips trailing CR from CRLF lines', () => {
    expect(diffLines({ oldText: null, newText: 'a\r\nb' })).toEqual([
      { type: 'added', text: 'a', newLine: 1 },
      { type: 'added', text: 'b', newLine: 2 }
    ])
  })
  it('counts actual changed lines, not total lines', () => {
    // 150-line file where only 3 lines changed → should show +3 −3, not +150 −150
    const oldLines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`)
    const newLines = [...oldLines]
    newLines[49] = 'changed line 50' // line 50 modified
    newLines[99] = 'changed line 100' // line 100 modified
    newLines[149] = 'changed line 150' // line 150 modified
    const oldText = oldLines.join('\n')
    const newText = newLines.join('\n')
    const counts = diffLineCounts({ oldText, newText })
    expect(counts).toEqual({ added: 3, removed: 3 })
  })
  it('reports identical files as zero changes', () => {
    expect(diffLineCounts({ oldText: 'a\nb\nc', newText: 'a\nb\nc' })).toEqual({
      added: 0,
      removed: 0
    })
  })
  it('ignores the trailing empty segment for newline-terminated text', () => {
    expect(diffLineCounts({ oldText: 'a\n', newText: 'b\n' })).toEqual({ added: 1, removed: 1 })
  })
  it('includes context lines around changes', () => {
    const lines = diffLines({ oldText: 'a\nb\nc\nd\ne', newText: 'a\nb\nX\nd\ne' })
    // Line 3 changed (c → X), so context lines 1,2,4,5 should appear
    const types = lines.map((l) => l.type)
    const texts = lines.map((l) => l.text)
    expect(types).toContain('context')
    expect(types).toContain('removed')
    expect(types).toContain('added')
    expect(texts).toContain('c')
    expect(texts).toContain('X')
  })
  it('shows ellipsis marker between non-adjacent change regions', () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const newLines = [...oldLines]
    newLines[0] = 'changed 1' // line 1
    newLines[19] = 'changed 20' // line 20
    const lines = diffLines({ oldText: oldLines.join('\n'), newText: newLines.join('\n') })
    const ellipsis = lines.find((l) => l.type === 'context' && l.text === '···')
    expect(ellipsis).toBeDefined()
  })
  it('includes line numbers on diff lines', () => {
    const lines = diffLines({ oldText: 'a\nb\nc', newText: 'a\nB\nc\nd' })
    const removed = lines.find((l) => l.type === 'removed')
    const added = lines.find((l) => l.type === 'added')
    expect(typeof removed?.oldLine).toBe('number')
    expect(typeof added?.newLine).toBe('number')
  })
  it('diffs a 13k-line file with sparse edits in bounded work', () => {
    // Regression: the full-file LCS allocated (m+1)*(n+1) cells (~1.4GB for
    // 13k lines) and hung the renderer for seconds per tool card.
    const oldLines = Array.from({ length: 13_000 }, (_, i) => `line ${i + 1}`)
    const newLines = [...oldLines]
    newLines[10] = 'changed near the top'
    newLines[6_500] = 'changed in the middle'
    newLines.splice(12_000, 3, 'rewritten tail a', 'rewritten tail b')
    const lines = diffLines({ oldText: oldLines.join('\n'), newText: newLines.join('\n') })
    const types = new Set(lines.map((l) => l.type))
    expect(types).toContain('removed')
    expect(types).toContain('added')
    expect(types).toContain('context')
    expect(lines.map((l) => l.text)).toContain('changed in the middle')
    expect(diffLineCounts({ oldText: oldLines.join('\n'), newText: newLines.join('\n') })).toEqual({
      added: 4,
      removed: 5
    })
  })
  it('handles pure insertions and deletions in the middle of a file', () => {
    // After prefix/suffix trim one side is empty — the diff must still emit
    // the inserted/removed lines rather than an empty result.
    const added = diffLines({ oldText: 'a\nb', newText: 'a\nX\nY\nb' })
    expect(added.filter((l) => l.type === 'added').map((l) => l.text)).toEqual(['X', 'Y'])
    const removed = diffLines({ oldText: 'a\nX\nY\nb', newText: 'a\nb' })
    expect(removed.filter((l) => l.type === 'removed').map((l) => l.text)).toEqual(['X', 'Y'])
    expect(diffLineCounts({ oldText: 'a\nb', newText: 'a\nX\nY\nb' })).toEqual({
      added: 2,
      removed: 0
    })
  })
  it('falls back to removed+added when two huge files share no anchors', () => {
    // Oversized, zero common lines: bounded diff stays truthful rather than
    // running an unbounded quadratic.
    const oldText = Array.from({ length: 3_000 }, (_, i) => `old ${i}`).join('\n')
    const newText = Array.from({ length: 3_000 }, (_, i) => `new ${i}`).join('\n')
    const lines = diffLines({ oldText, newText })
    expect(lines.every((l) => l.type === 'removed' || l.type === 'added')).toBe(true)
    expect(diffLineCounts({ oldText, newText })).toEqual({ added: 3_000, removed: 3_000 })
  })
})

describe('permission option helpers', () => {
  const options: PermissionOption[] = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' }
  ]
  it('classifies allow vs reject', () => {
    expect(isAllowOption(options[0])).toBe(true)
    expect(isRejectOption(options[0])).toBe(false)
    expect(isRejectOption(options[2])).toBe(true)
  })
  it('picks a reject option when present, null otherwise', () => {
    expect(pickRejectOption(options)?.optionId).toBe('r1')
    expect(pickRejectOption(options.slice(0, 2))).toBeNull()
  })
  it('prefers reject_once over reject_always for dismiss', () => {
    const withAlwaysFirst: PermissionOption[] = [
      { optionId: 'ra', name: 'Reject always', kind: 'reject_always' },
      { optionId: 'ro', name: 'Reject once', kind: 'reject_once' }
    ]
    expect(pickRejectOption(withAlwaysFirst)?.optionId).toBe('ro')
    expect(pickRejectOption(withAlwaysFirst.slice(0, 1))?.optionId).toBe('ra')
  })
  it('picks allow_once as the primary allow when present', () => {
    expect(pickPrimaryAllowOption(options)?.optionId).toBe('a1')
    expect(pickPrimaryAllowOption(options.slice(1, 2))?.optionId).toBe('a2')
    expect(pickPrimaryAllowOption([])).toBeNull()
  })
})
