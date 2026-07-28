import { describe, expect, it } from 'vitest'
import {
  activeMentionToken,
  buildMentionSections,
  isMentionTrigger,
  type MentionMatch,
  spliceMentionToken
} from './mention-menu-model'

describe('activeMentionToken', () => {
  it('opens on a bare @ at the start', () => {
    expect(activeMentionToken('@', 1)).toEqual({ at: 0, end: 1, query: '' })
  })

  it('opens on a leading @word with the caret at the end', () => {
    expect(activeMentionToken('@auth', 5)).toEqual({ at: 0, end: 5, query: 'auth' })
  })

  it('opens mid-text when @ is preceded by whitespace', () => {
    expect(activeMentionToken('look at @auth', 13)).toEqual({ at: 8, end: 13, query: 'auth' })
  })

  it('does NOT open when @ is preceded by a word char (email@host)', () => {
    expect(activeMentionToken('email@host', 10)).toBeNull()
  })

  it('does NOT open when there is no @', () => {
    expect(activeMentionToken('no mention here', 15)).toBeNull()
  })

  it('does NOT open on an empty input', () => {
    expect(activeMentionToken('', 0)).toBeNull()
  })

  it('closes the token at the first whitespace after @', () => {
    // caret right after `auth` (before the space) → still open
    expect(activeMentionToken('@auth foo', 5)).toEqual({ at: 0, end: 5, query: 'auth' })
    // caret after the space → closed
    expect(activeMentionToken('@auth foo', 6)).toBeNull()
    // caret at end of text → closed
    expect(activeMentionToken('@auth foo', 9)).toBeNull()
  })

  it('resolves to the nearest valid @ token when several exist', () => {
    expect(activeMentionToken('@a @b', 5)).toEqual({ at: 3, end: 5, query: 'b' })
    expect(activeMentionToken('@a @b', 2)).toEqual({ at: 0, end: 2, query: 'a' })
  })

  it('treats a second @ as a token boundary, not part of the query', () => {
    // @a@b with caret at end: the second @ is invalid (prev='a'), and the
    // first @'s word ends at the second @, so the caret is outside it → null.
    expect(activeMentionToken('@a@b', 4)).toBeNull()
  })

  it('uses the full @word as the query when the caret is mid-word', () => {
    // `@au|th` → the word is `auth`; splice will replace the whole word.
    expect(activeMentionToken('@auth', 3)).toEqual({ at: 0, end: 5, query: 'auth' })
  })

  it('rejects an out-of-range caret', () => {
    expect(activeMentionToken('@auth', -1)).toBeNull()
    expect(activeMentionToken('@auth', 99)).toBeNull()
  })
})

describe('isMentionTrigger', () => {
  it('mirrors activeMentionToken presence', () => {
    expect(isMentionTrigger('@auth', 5)).toBe(true)
    expect(isMentionTrigger('email@host', 10)).toBe(false)
    expect(isMentionTrigger('', 0)).toBe(false)
  })
})

describe('spliceMentionToken', () => {
  it('removes the @token from a leading mention', () => {
    const token = activeMentionToken('@auth', 5)!
    expect(spliceMentionToken('@auth', token)).toBe('')
  })

  it('removes only the @token, preserving surrounding text', () => {
    // caret 13 = right after `@auth`, before the trailing space.
    const token = activeMentionToken('look at @auth now', 13)!
    expect(spliceMentionToken('look at @auth now', token)).toBe('look at  now')
  })

  it('removes the nearest token when several exist', () => {
    const token = activeMentionToken('@a @b', 5)!
    expect(spliceMentionToken('@a @b', token)).toBe('@a ')
  })

  it('removes the whole @word when the caret was mid-word', () => {
    const token = activeMentionToken('@auth', 3)!
    expect(spliceMentionToken('@auth', token)).toBe('')
  })
})

const match = (relPath: string, ignored = false): MentionMatch => ({
  relPath,
  absPath: `/root/${relPath}`,
  name: relPath.split(/[\\/]/).pop() ?? relPath,
  ignored
})

describe('buildMentionSections', () => {
  it('shows only a Recents section when the filter is empty', () => {
    const sections = buildMentionSections({
      matches: [match('src/a.ts')],
      recents: [match('src/recent.ts'), match('README.md')],
      filter: ''
    })
    expect(sections).toHaveLength(1)
    expect(sections[0].id).toBe('recents')
    expect(sections[0].heading).toBe('Recent')
    expect(sections[0].items).toHaveLength(2)
  })

  it('returns no sections when the filter is empty and there are no recents', () => {
    expect(buildMentionSections({ matches: [match('src/a.ts')], recents: [], filter: '' })).toEqual(
      []
    )
  })

  it('shows only a Files section when the filter is non-empty', () => {
    const sections = buildMentionSections({
      matches: [match('src/auth.ts'), match('lib/auth.ts')],
      recents: [match('src/recent.ts')],
      filter: 'auth'
    })
    expect(sections).toHaveLength(1)
    expect(sections[0].id).toBe('files')
    expect(sections[0].heading).toBe('Files')
    expect(sections[0].items).toHaveLength(2)
  })

  it('returns no sections when the filter is non-empty and there are no matches', () => {
    expect(
      buildMentionSections({ matches: [], recents: [match('src/r.ts')], filter: 'zzz' })
    ).toEqual([])
  })

  it('deduplicates matches by absolute path', () => {
    const sections = buildMentionSections({
      matches: [match('src/auth.ts'), match('src/auth.ts')],
      recents: [],
      filter: 'a'
    })
    expect(sections[0].items).toHaveLength(1)
  })

  it('carries name, relPath, ignored, and the match payload on each item', () => {
    const sections = buildMentionSections({
      matches: [match('node_modules/pkg/index.js', true)],
      recents: [],
      filter: 'index'
    })
    const item = sections[0].items[0]
    expect(item.label).toBe('index.js')
    expect(item.description).toBe('node_modules/pkg/index.js')
    expect(item.ignored).toBe(true)
    expect(item.key).toBe('/root/node_modules/pkg/index.js')
    expect(item.payload.absPath).toBe('/root/node_modules/pkg/index.js')
  })
})
