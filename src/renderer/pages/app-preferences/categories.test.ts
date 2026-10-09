import { describe, expect, it } from 'vitest'
import { searchSettings } from '@/lib/settings-search'
import { APP_PREF_SEARCH_INDEX } from './categories'

// L-28: the screen reader switch is reachable from the settings search box.
describe('APP_PREF_SEARCH_INDEX screen reader mode (L-28)', () => {
  it.each([
    'screen reader',
    'talkback',
    'voiceover',
    'a11y',
    'accessibility'
  ])('ranks "Screen reader mode" first in Terminal Appearance for "%s"', (query) => {
    const results = searchSettings(query, APP_PREF_SEARCH_INDEX)

    expect(results[0]).toEqual(
      expect.objectContaining({ categoryId: 'appearance', label: 'Screen reader mode' })
    )
  })

  it('has exactly one Screen reader mode entry, in the appearance category', () => {
    const entries = APP_PREF_SEARCH_INDEX.filter((entry) => entry.label === 'Screen reader mode')

    expect(entries).toHaveLength(1)
    expect(entries[0]?.categoryId).toBe('appearance')
    expect(entries[0]?.description).toBe('Make terminal output readable by screen readers.')
    expect(entries[0]?.keywords).toEqual(
      expect.arrayContaining(['accessibility', 'a11y', 'talkback', 'voiceover', 'nvda'])
    )
  })
})
