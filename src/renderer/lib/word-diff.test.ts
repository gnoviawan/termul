import { describe, expect, it } from 'vitest'
import { computeWordDiff, getChangedRanges } from './word-diff'

describe('computeWordDiff', () => {
  it('returns all common for identical lines', () => {
    const segments = computeWordDiff('hello world', 'hello world')
    expect(segments).toEqual([{ text: 'hello world', type: 'common' }])
  })

  it('returns all added when old text is empty', () => {
    const segments = computeWordDiff('', 'new content')
    expect(segments).toEqual([{ text: 'new content', type: 'added' }])
  })

  it('returns all removed when new text is empty', () => {
    const segments = computeWordDiff('old content', '')
    expect(segments).toEqual([{ text: 'old content', type: 'removed' }])
  })

  it('handles fully different lines', () => {
    const segments = computeWordDiff('aaa', 'bbb')
    expect(segments).toEqual([
      { text: 'aaa', type: 'removed' },
      { text: 'bbb', type: 'added' }
    ])
  })

  it('handles partial change with common words', () => {
    const segments = computeWordDiff('const foo = 1', 'const bar = 2')
    // Common: "const ", removed: "foo", common: " = ", removed: "1", added: "bar", added: "2"
    // The exact order depends on LCS backtracking, but types should be present
    const hasCommon = segments.some((s) => s.type === 'common')
    const hasRemoved = segments.some((s) => s.type === 'removed')
    const hasAdded = segments.some((s) => s.type === 'added')
    expect(hasCommon).toBe(true)
    expect(hasRemoved).toBe(true)
    expect(hasAdded).toBe(true)

    // Reconstructed text should match originals
    const reconstructedOld = segments
      .filter((s) => s.type !== 'added')
      .map((s) => s.text)
      .join('')
    const reconstructedNew = segments
      .filter((s) => s.type !== 'removed')
      .map((s) => s.text)
      .join('')
    expect(reconstructedOld).toBe('const foo = 1')
    expect(reconstructedNew).toBe('const bar = 2')
  })

  it('handles whitespace-only strings', () => {
    const segments = computeWordDiff('  ', ' ')
    expect(segments.length).toBeGreaterThan(0)
    // Reconstruction should work
    const reconstructedOld = segments
      .filter((s) => s.type !== 'added')
      .map((s) => s.text)
      .join('')
    const reconstructedNew = segments
      .filter((s) => s.type !== 'removed')
      .map((s) => s.text)
      .join('')
    expect(reconstructedOld).toBe('  ')
    expect(reconstructedNew).toBe(' ')
  })

  it('merges consecutive segments of the same type', () => {
    const segments = computeWordDiff('a x b', 'a y b')
    // "a " is common, "x" removed, " " common or removed/added, "y" added, " b" common
    const types = segments.map((s) => s.type)
    // No two consecutive segments should have the same type
    for (let i = 1; i < types.length; i += 1) {
      expect(types[i]).not.toBe(types[i - 1])
    }
  })

  it('handles single character changes', () => {
    const segments = computeWordDiff('x', 'y')
    expect(segments).toEqual([
      { text: 'x', type: 'removed' },
      { text: 'y', type: 'added' }
    ])
  })
})

describe('getChangedRanges', () => {
  it('returns ranges for removed segments on deletion side', () => {
    const segments = computeWordDiff('old line', 'new line')
    const removedRanges = getChangedRanges(segments, 'removed')
    expect(removedRanges.length).toBeGreaterThan(0)
    // The ranges should cover the removed text
    for (const range of removedRanges) {
      expect(range.end).toBeGreaterThan(range.start)
    }
  })

  it('returns ranges for added segments on addition side', () => {
    const segments = computeWordDiff('old line', 'new line')
    const addedRanges = getChangedRanges(segments, 'added')
    expect(addedRanges.length).toBeGreaterThan(0)
    for (const range of addedRanges) {
      expect(range.end).toBeGreaterThan(range.start)
    }
  })

  it('returns empty for identical lines', () => {
    const segments = computeWordDiff('same', 'same')
    expect(getChangedRanges(segments, 'removed')).toEqual([])
    expect(getChangedRanges(segments, 'added')).toEqual([])
  })

  it('returns side-relative coordinates that reconstruct correct text', () => {
    const oldText = 'a x b'
    const newText = 'a b y'
    const segments = computeWordDiff(oldText, newText)

    const removedRanges = getChangedRanges(segments, 'removed')
    const addedRanges = getChangedRanges(segments, 'added')

    // Removed ranges should slice into oldText and match removed segment text
    const removedFromRanges = removedRanges.map((r) => oldText.slice(r.start, r.end)).join('')
    const expectedRemoved = segments
      .filter((s) => s.type === 'removed')
      .map((s) => s.text)
      .join('')
    expect(removedFromRanges).toBe(expectedRemoved)

    // Added ranges should slice into newText and match added segment text
    const addedFromRanges = addedRanges.map((r) => newText.slice(r.start, r.end)).join('')
    const expectedAdded = segments
      .filter((s) => s.type === 'added')
      .map((s) => s.text)
      .join('')
    expect(addedFromRanges).toBe(expectedAdded)

    // Ranges must stay within text bounds
    expect(removedRanges.every((r) => r.end <= oldText.length)).toBe(true)
    expect(addedRanges.every((r) => r.end <= newText.length)).toBe(true)
  })
})
