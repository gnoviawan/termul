import { describe, expect, it } from 'vitest'
import {
  extractSkillNames,
  insertSkillToken,
  parseSkillSegments,
  removeSkillTokenBeforeCaret,
  replaceSkillTokensInline,
  SKILL_PAD_CHAR,
  SKILL_PAD_END,
  SKILL_PAD_START,
  SKILL_TOKEN_END,
  SKILL_TOKEN_START,
  skillToken
} from '@/lib/skill-tokens'

const T = (name: string): string => skillToken(name)
/** A token carrying a 3-char FIGURE-SPACE padding block (as `measureSkillPadding` would). */
const Tp = (name: string, n = 3): string => skillToken(name, SKILL_PAD_CHAR.repeat(n))

describe('parseSkillSegments', () => {
  it('returns no segments for an empty value', () => {
    expect(parseSkillSegments('')).toEqual([])
  })

  it('returns a single text segment for plain text with no tokens', () => {
    expect(parseSkillSegments('hello world')).toEqual([{ kind: 'text', text: 'hello world' }])
  })

  it('parses a lone token into a single skill segment', () => {
    expect(parseSkillSegments(T('git-worktree'))).toEqual([
      { kind: 'skill', name: 'git-worktree', raw: T('git-worktree'), padding: '' }
    ])
  })

  it('parses text + token + text in order', () => {
    expect(parseSkillSegments(`use this ${T('git-worktree')} then`)).toEqual([
      { kind: 'text', text: 'use this ' },
      { kind: 'skill', name: 'git-worktree', raw: T('git-worktree'), padding: '' },
      { kind: 'text', text: ' then' }
    ])
  })

  it('parses adjacent tokens with no text between them', () => {
    expect(parseSkillSegments(`${T('a')}${T('b')}`)).toEqual([
      { kind: 'skill', name: 'a', raw: T('a'), padding: '' },
      { kind: 'skill', name: 'b', raw: T('b'), padding: '' }
    ])
  })

  it('parses a token at the start and a token at the end', () => {
    expect(parseSkillSegments(`${T('a')}mid${T('b')}`)).toEqual([
      { kind: 'skill', name: 'a', raw: T('a'), padding: '' },
      { kind: 'text', text: 'mid' },
      { kind: 'skill', name: 'b', raw: T('b'), padding: '' }
    ])
  })

  it('handles hyphenated skill names', () => {
    expect(parseSkillSegments(T('release-version'))).toEqual([
      { kind: 'skill', name: 'release-version', raw: T('release-version'), padding: '' }
    ])
  })

  it('consumes the padding block into the skill segment (not as text)', () => {
    const token = Tp('git-worktree', 3)
    expect(parseSkillSegments(`use ${token} now`)).toEqual([
      { kind: 'text', text: 'use ' },
      {
        kind: 'skill',
        name: 'git-worktree',
        raw: token,
        padding: SKILL_PAD_CHAR.repeat(3)
      },
      { kind: 'text', text: ' now' }
    ])
  })

  it('parses a padded token with no surrounding text', () => {
    const token = Tp('a', 1)
    expect(parseSkillSegments(token)).toEqual([
      { kind: 'skill', name: 'a', raw: token, padding: SKILL_PAD_CHAR }
    ])
  })

  it('treats an unterminated start sentinel as plain text', () => {
    const raw = `hello ${SKILL_TOKEN_START}git-worktree`
    expect(parseSkillSegments(raw)).toEqual([{ kind: 'text', text: raw }])
  })

  it('treats an empty-name token as plain text', () => {
    const raw = `${SKILL_TOKEN_START}${SKILL_TOKEN_END}`
    expect(parseSkillSegments(raw)).toEqual([{ kind: 'text', text: raw }])
  })

  it('drops a malformed padding block (no closing sentinel) but keeps the token', () => {
    const malformed = `${SKILL_TOKEN_START}git-worktree${SKILL_TOKEN_END}${SKILL_PAD_START}pad`
    const segments = parseSkillSegments(malformed)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toEqual({
      kind: 'skill',
      name: 'git-worktree',
      raw: `${SKILL_TOKEN_START}git-worktree${SKILL_TOKEN_END}`,
      padding: ''
    })
    expect(segments[1]).toEqual({ kind: 'text', text: `${SKILL_PAD_START}pad` })
  })
})

describe('insertSkillToken', () => {
  it('inserts a token at the caret with a trailing space and places the caret after it', () => {
    const { value, caret } = insertSkillToken('hello ', 6, 'git-worktree', 0)
    expect(value).toBe(`hello ${T('git-worktree')} `)
    expect(caret).toBe(`hello `.length + T('git-worktree').length + 1)
    expect(caret).toBe(value.length)
  })

  it('deletes the preceding filter range when splicing (the / trigger text)', () => {
    // value = "use this skill /" (length 16); caret at end; deleteBefore=1
    // removes the trailing "/".
    const { value, caret } = insertSkillToken('use this skill /', 16, 'git-worktree', 1)
    expect(value).toBe(`use this skill ${T('git-worktree')} `)
    expect(caret).toBe(value.length)
  })

  it('inserts at the start when the value is empty', () => {
    const { value, caret } = insertSkillToken('', 0, 'git-worktree', 0)
    expect(value).toBe(`${T('git-worktree')} `)
    expect(caret).toBe(value.length)
  })

  it('removes a leading /filter and inserts the token at position 0', () => {
    const { value, caret } = insertSkillToken('/git', 4, 'git-worktree', 4)
    expect(value).toBe(`${T('git-worktree')} `)
    expect(caret).toBe(value.length)
  })

  it('preserves trailing text when splicing mid-value', () => {
    const { value, caret } = insertSkillToken('hello world', 5, 'git-worktree', 0)
    expect(value).toBe(`hello${T('git-worktree')}  world`)
    expect(caret).toBe(`hello`.length + T('git-worktree').length + 1)
  })

  it('splices the padding block inside the token so the caret lands after the space', () => {
    const padding = SKILL_PAD_CHAR.repeat(3)
    const { value, caret } = insertSkillToken('hello ', 6, 'git-worktree', 0, padding)
    expect(value).toBe(`hello ${skillToken('git-worktree', padding)} `)
    expect(caret).toBe(`hello `.length + skillToken('git-worktree', padding).length + 1)
    expect(caret).toBe(value.length)
  })
})

describe('removeSkillTokenBeforeCaret', () => {
  it('removes the whole token plus trailing space when the caret is right after the space', () => {
    const value = `use this ${T('git-worktree')} `
    const caret = value.length
    const result = removeSkillTokenBeforeCaret(value, caret)
    expect(result.removed).toBe(true)
    if (!result.removed) return
    expect(result.value).toBe('use this ')
    expect(result.caret).toBe('use this '.length)
  })

  it('removes the whole token when the caret is right after the token end (no trailing space)', () => {
    const value = `use this ${T('git-worktree')}`
    const caret = value.length
    const result = removeSkillTokenBeforeCaret(value, caret)
    expect(result.removed).toBe(true)
    if (!result.removed) return
    expect(result.value).toBe('use this ')
    expect(result.caret).toBe('use this '.length)
  })

  it('removes a token at the start of the value', () => {
    const value = `${T('git-worktree')} `
    const result = removeSkillTokenBeforeCaret(value, value.length)
    expect(result.removed).toBe(true)
    if (!result.removed) return
    expect(result.value).toBe('')
    expect(result.caret).toBe(0)
  })

  it('removes a padded token plus its trailing space in one backspace', () => {
    const token = Tp('git-worktree', 4)
    const value = `use this ${token} `
    const result = removeSkillTokenBeforeCaret(value, value.length)
    expect(result.removed).toBe(true)
    if (!result.removed) return
    expect(result.value).toBe('use this ')
    expect(result.caret).toBe('use this '.length)
  })

  it('removes a padded token with no trailing space (caret right after the pad end)', () => {
    const token = Tp('git-worktree', 2)
    const value = `use this ${token}`
    const result = removeSkillTokenBeforeCaret(value, value.length)
    expect(result.removed).toBe(true)
    if (!result.removed) return
    expect(result.value).toBe('use this ')
    expect(result.caret).toBe('use this '.length)
  })

  it('returns removed:false when a stray pad-end has no matching pad-start before the caret', () => {
    // A lone \uE003 with no \uE002 before it must not be mistaken for a token.
    expect(removeSkillTokenBeforeCaret(`hello ${SKILL_PAD_END} `, 8).removed).toBe(false)
  })

  it('returns removed:false when the caret is in plain text (default one-char backspace)', () => {
    const value = 'hello world'
    expect(removeSkillTokenBeforeCaret(value, 5).removed).toBe(false)
  })

  it('returns removed:false when only a lone trailing space precedes the caret (no token)', () => {
    expect(removeSkillTokenBeforeCaret('hello ', 6).removed).toBe(false)
  })

  it('returns removed:false for an out-of-range caret', () => {
    expect(removeSkillTokenBeforeCaret(T('a'), 0).removed).toBe(false)
    expect(removeSkillTokenBeforeCaret(T('a'), 99).removed).toBe(false)
  })
})

describe('replaceSkillTokensInline', () => {
  it('replaces a single token with (name)', () => {
    expect(replaceSkillTokensInline(`use this ${T('git-worktree')} now`)).toBe(
      'use this (git-worktree) now'
    )
  })

  it('preserves inline duplicate positions', () => {
    expect(replaceSkillTokensInline(`${T('a')} and ${T('a')} again`)).toBe('(a) and (a) again')
  })

  it('passes plain text through verbatim', () => {
    expect(replaceSkillTokensInline('just text')).toBe('just text')
  })

  it('returns empty string for empty input', () => {
    expect(replaceSkillTokensInline('')).toBe('')
  })

  it('replaces adjacent tokens', () => {
    expect(replaceSkillTokensInline(`${T('a')}${T('b')}`)).toBe('(a)(b)')
  })

  it('does not touch @mentions or /slashes in the text', () => {
    expect(replaceSkillTokensInline('@user /cmd')).toBe('@user /cmd')
  })

  it('strips the padding block — a padded token still maps to (name) only', () => {
    expect(replaceSkillTokensInline(`use this ${Tp('git-worktree', 5)} now`)).toBe(
      'use this (git-worktree) now'
    )
    // No figure-space chars leak into the wire text.
    expect(replaceSkillTokensInline(Tp('a', 3))).toBe('(a)')
    expect(replaceSkillTokensInline(Tp('a', 3)).includes(SKILL_PAD_CHAR)).toBe(false)
  })
})

describe('extractSkillNames', () => {
  it('returns names in first-appearance order, unique by name', () => {
    expect(extractSkillNames(`${T('a')} ${T('b')} ${T('a')}`)).toEqual(['a', 'b'])
  })

  it('returns an empty array for plain text with no tokens', () => {
    expect(extractSkillNames('hello world')).toEqual([])
  })

  it('returns an empty array for empty input', () => {
    expect(extractSkillNames('')).toEqual([])
  })

  it('handles hyphenated names', () => {
    expect(extractSkillNames(`${T('git-worktree')} ${T('release-version')}`)).toEqual([
      'git-worktree',
      'release-version'
    ])
  })

  it('extracts names from padded tokens (padding is not part of the name)', () => {
    expect(extractSkillNames(`${Tp('git-worktree', 4)} ${Tp('a', 1)}`)).toEqual([
      'git-worktree',
      'a'
    ])
  })
})

describe('skillToken', () => {
  it('omits the padding block when padding is empty (backward compatible)', () => {
    expect(skillToken('git-worktree')).toBe(`${SKILL_TOKEN_START}git-worktree${SKILL_TOKEN_END}`)
    expect(skillToken('git-worktree', '')).toBe(skillToken('git-worktree'))
  })

  it('wraps the padding inside the sentinel block after the name token', () => {
    const pad = SKILL_PAD_CHAR.repeat(3)
    expect(skillToken('git-worktree', pad)).toBe(
      `${SKILL_TOKEN_START}git-worktree${SKILL_TOKEN_END}${SKILL_PAD_START}${pad}${SKILL_PAD_END}`
    )
  })
})
