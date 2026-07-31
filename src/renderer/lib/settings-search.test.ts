import { describe, expect, it } from 'vitest'
import {
  fuzzyScore,
  type SettingsSearchEntry,
  scoreEntry,
  searchSettings
} from '@/lib/settings-search'

describe('fuzzyScore', () => {
  it('returns 0 for an empty query', () => {
    expect(fuzzyScore('', 'Font Family')).toBe(0)
  })

  it('matches a case-insensitive subsequence', () => {
    expect(fuzzyScore('ff', 'Font Family')).not.toBeNull()
    expect(fuzzyScore('FONT', 'font family')).not.toBeNull()
  })

  it('returns null when characters are not present in order', () => {
    expect(fuzzyScore('zx', 'Font Family')).toBeNull()
    expect(fuzzyScore('yltimaf', 'Font Family')).toBeNull()
  })

  it('returns null when the query is longer than the text', () => {
    expect(fuzzyScore('abcdef', 'abc')).toBeNull()
  })

  it('scores consecutive matches higher than scattered ones', () => {
    const consecutive = fuzzyScore('font', 'font family')
    const scattered = fuzzyScore('fnt', 'font family')
    expect(consecutive).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(consecutive as number).toBeGreaterThan(scattered as number)
  })

  it('rewards word-boundary matches', () => {
    // Same query "fa": it starts a word (after the space) in "go fast" but is
    // mid-word in "gofast". The boundary match should score higher.
    const boundary = fuzzyScore('fa', 'go fast')
    const midword = fuzzyScore('fa', 'gofast')
    expect(boundary).not.toBeNull()
    expect(midword).not.toBeNull()
    expect(boundary as number).toBeGreaterThan(midword as number)
  })
})

describe('scoreEntry', () => {
  const entry: SettingsSearchEntry = {
    categoryId: 'appearance',
    label: 'Font Family',
    description: 'Choose a monospace font for terminal text.',
    keywords: ['typeface']
  }

  it('returns 0 for an empty query', () => {
    expect(scoreEntry('', entry)).toBe(0)
  })

  it('weights a label match above a description-only match', () => {
    // Same query in both fields: the label match should outrank a description match.
    const labelEntry: SettingsSearchEntry = { categoryId: 'shell', label: 'Default Shell' }
    const descEntry: SettingsSearchEntry = {
      categoryId: 'updates',
      label: 'Updates',
      description: 'restart the shell after updating'
    }
    const labelMatch = scoreEntry('shell', labelEntry) as number
    const descMatch = scoreEntry('shell', descEntry) as number
    expect(labelMatch).not.toBeNull()
    expect(descMatch).not.toBeNull()
    expect(labelMatch).toBeGreaterThan(descMatch)
  })

  it('matches via keywords', () => {
    expect(scoreEntry('typeface', entry)).not.toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(scoreEntry('zzz', entry)).toBeNull()
  })
})

describe('searchSettings', () => {
  const index: SettingsSearchEntry[] = [
    { categoryId: 'appearance', label: 'Font Family', description: 'monospace font' },
    { categoryId: 'appearance', label: 'Font Size', description: 'adjust text size' },
    { categoryId: 'updates', label: 'Auto-update', description: 'check for updates' },
    { categoryId: 'shell', label: 'Default Shell', keywords: ['bash', 'zsh'] }
  ]

  it('returns an empty array for an empty or whitespace query', () => {
    expect(searchSettings('', index)).toEqual([])
    expect(searchSettings('   ', index)).toEqual([])
  })

  it('surfaces font settings for the query "font"', () => {
    const results = searchSettings('font', index)
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results.every((r) => r.label.startsWith('Font'))).toBe(true)
  })

  it('matches a setting through its keywords', () => {
    const results = searchSettings('zsh', index)
    expect(results[0]?.label).toBe('Default Shell')
  })

  it('sorts results by descending score', () => {
    const results = searchSettings('update', index)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })
})
