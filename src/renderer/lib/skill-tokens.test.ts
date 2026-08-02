import { describe, expect, it } from 'vitest'
import {
  extractSkillNames,
  insertSkillToken,
  parseSkillSegments,
  removeSkillTokenBeforeCaret,
  replaceSkillTokensInline,
  SKILL_TOKEN_END,
  SKILL_TOKEN_START,
  skillToken
} from '@/lib/skill-tokens'

const T = (name: string): string => skillToken(name)

describe('parseSkillSegments', () => {
  it('returns a single empty text segment for an empty value', () => {
    expect(parseSkillSegments('')).toEqual([])
  })

  it('returns a single text segment for plain text with no tokens', () => {
    expect(parseSkillSegments('hello world')).toEqual([{ kind: 'text', text: 'hello world' }])
  })

  it('parses a lone token into a single skill segment', () => {
    expect(parseSkillSegments(T('git-worktree'))).toEqual([
      { kind: 'skill', name: 'git-worktree', raw: T('git-worktree') }
    ])
  })

  it('parses text + token + text in order', () => {
    expect(parseSkillSegments(`use this ${T('git-worktree')} then`)).toEqual([
      { kind: 'text', text: 'use this ' },
      { kind: 'skill', name: 'git-worktree', raw: T('git-worktree') },
      { kind: 'text', text: ' then' }
    ])
  })

  it('parses adjacent tokens with no text between them', () => {
    expect(parseSkillSegments(`${T('a')}${T('b')}`)).toEqual([
      { kind: 'skill', name: 'a', raw: T('a') },
      { kind: 'skill', name: 'b', raw: T('b') }
    ])
  })

  it('parses a token at the start and a token at the end', () => {
    expect(parseSkillSegments(`${T('a')}mid${T('b')}`)).toEqual([
      { kind: 'skill', name: 'a', raw: T('a') },
      { kind: 'text', text: 'mid' },
      { kind: 'skill', name: 'b', raw: T('b') }
    ])
  })

  it('handles hyphenated skill names', () => {
    expect(parseSkillSegments(T('release-version'))).toEqual([
      { kind: 'skill', name: 'release-version', raw: T('release-version') }
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
})

describe('insertSkillToken', () => {
  it('inserts a token at the caret with a trailing space and places the caret after it', () => {
    const { value, caret } = insertSkillToken('hello ', 6, 'git-worktree', 0)
    expect(value).toBe(`hello ${T('git-worktree')} `)
    expect(caret).toBe(`hello `.length + T('git-worktree').length + 1)
    expect(caret).toBe(value.length)
  })

  it('deletes the preceding filter range when splicing (the / trigger text)', () => {
    // value = "use this skill /" caret at end (15), deleteBefore=1 removes the "/"
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
})
