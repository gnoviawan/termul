import { describe, expect, it } from 'vitest'
import {
  createSelectionContext,
  parseSelectionContextSegments,
  replaceSelectionContextsWithMarkers,
  selectionContextPreview,
  selectionContextsToDisplay,
  selectionContextToken,
  serializeSelectionContexts
} from '@/lib/composer/selection-context'
import { commandToken, fileToken, skillToken } from '@/lib/skill-tokens'

function prose(text: string): string {
  const ctx = createSelectionContext(text)
  if (!ctx) throw new Error('empty context')
  return selectionContextToken(ctx)
}

function code(text: string, language: string): string {
  const ctx = createSelectionContext(text, language)
  if (!ctx) throw new Error('empty context')
  return selectionContextToken(ctx)
}

describe('createSelectionContext', () => {
  it('returns null for an empty or whitespace-only selection', () => {
    expect(createSelectionContext('')).toBeNull()
    expect(createSelectionContext('  \n\t ')).toBeNull()
    expect(createSelectionContext('\n\n', 'ts')).toBeNull()
  })

  it('trims prose, normalizes CRLF, and strips private-use sentinels', () => {
    expect(createSelectionContext('  a\r\nb\uE000c\u001F  ')).toEqual({ text: 'a\nbc' })
  })

  it('keeps code indentation and drops edge blank lines', () => {
    expect(createSelectionContext('\n  if (x) {\n    y()\n  }\n\n', 'ts')).toEqual({
      text: '  if (x) {\n    y()\n  }',
      language: 'ts'
    })
  })

  it('sanitizes the language and maps the renderer fallback "text" to no language', () => {
    expect(createSelectionContext('x', 'c++ <b>')).toEqual({ text: 'x', language: 'c++b' })
    expect(createSelectionContext('x', 'text')).toEqual({ text: 'x', language: '' })
  })

  it('keeps an empty fenced block as prose instead of an empty code context', () => {
    expect(createSelectionContext('```\n\n```')).toEqual({ text: '```\n\n```' })
    const out = serializeSelectionContexts(prose('```ts\n  \n```'))
    expect(selectionContextsToDisplay(out)).toBe(prose('```ts\n  \n```'))
  })

  it('serializes code with very many backtick runs without overflowing', () => {
    const many = '`a` '.repeat(200_000)
    expect(() => serializeSelectionContexts(code(many, 'md'))).not.toThrow()
  })

  it('treats a selected fenced block as code with its language', () => {
    expect(createSelectionContext('```py\nprint(1)\n```')).toEqual({
      text: 'print(1)',
      language: 'py'
    })
  })
})

describe('selection context tokens', () => {
  it('round-trips prose and code through the display-string token', () => {
    const value = `see ${prose('a b\n/usr @x')} and ${code('let a = 1', 'ts')}`
    const segments = parseSelectionContextSegments(value)
    expect(segments).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'context', context: { text: 'a b\n/usr @x' } },
      { kind: 'text', text: ' and ' },
      { kind: 'context', context: { text: 'let a = 1', language: 'ts' } }
    ])
  })

  it('keeps the token payload free of whitespace, "/" and "@" so composer scanners skip it', () => {
    const token = prose('open /usr/bin and @file now')
    expect(token).not.toMatch(/[\s/@]/)
  })

  it('treats malformed tokens as plain text', () => {
    expect(parseSelectionContextSegments('a\uE008%E0%A4%A\uE009b')).toEqual([
      { kind: 'text', text: 'a\uE008%E0%A4%A\uE009b' }
    ])
    expect(parseSelectionContextSegments('a\uE008unterminated')).toEqual([
      { kind: 'text', text: 'a\uE008unterminated' }
    ])
  })
})

describe('serializeSelectionContexts', () => {
  it('returns the value unchanged when it has no selection context', () => {
    const value = `hi ${skillToken('lint')} [Context 1] ${fileToken('a.ts', '/p/a.ts')}`
    expect(serializeSelectionContexts(value)).toBe(value)
  })

  it('puts numbered quote blocks first and markers at the chip positions', () => {
    const value = `Compare ${prose('first line\n\nthird line')} with ${code('const x = 1', 'ts')} please`
    expect(serializeSelectionContexts(value)).toBe(
      [
        'Context 1 (selected from the conversation):',
        '> first line',
        '>',
        '> third line',
        '',
        'Context 2 (selected from the conversation):',
        '> ```ts',
        '> const x = 1',
        '> ```',
        '',
        'Compare [Context 1] with [Context 2] please'
      ].join('\n')
    )
  })

  it('numbers contexts by chip order, not by insertion history', () => {
    const value = `${prose('B')} then ${prose('A')}`
    const out = serializeSelectionContexts(value)
    expect(out).toContain('Context 1 (selected from the conversation):\n> B')
    expect(out).toContain('Context 2 (selected from the conversation):\n> A')
    expect(out.endsWith('[Context 1] then [Context 2]')).toBe(true)
  })

  it('uses a fence longer than any backtick run inside the code', () => {
    const out = serializeSelectionContexts(code('a ``` b', 'md'))
    expect(out).toContain('> ````md\n> a ``` b\n> ````')
  })

  it('escapes literal markers the user typed, outside other tokens', () => {
    const value = `[Context 1] vs ${prose('x')} vs \\[Context 2] ${fileToken('[Context 3].md', '/p/[Context 3].md')}`
    const out = serializeSelectionContexts(value)
    expect(
      out.endsWith(
        `\\[Context 1] vs [Context 1] vs \\\\[Context 2] ${fileToken('[Context 3].md', '/p/[Context 3].md')}`
      )
    ).toBe(true)
  })

  it('keeps a leading slash command first so the agent still runs it', () => {
    const value = `${commandToken('review')} ${prose('x')} focus`
    expect(serializeSelectionContexts(value)).toBe(
      `${commandToken('review')}\n\nContext 1 (selected from the conversation):\n> x\n\n[Context 1] focus`
    )
  })

  it('trims the sentence so the display and the prompt agree', () => {
    expect(serializeSelectionContexts(`  ${prose('x')}  \n`)).toBe(
      'Context 1 (selected from the conversation):\n> x\n\n[Context 1]'
    )
  })
})

describe('selectionContextsToDisplay', () => {
  const cases: Array<[string, string]> = [
    ['prose and code', `Compare ${prose('a\n\n  b ')} with ${code('x\n  y', 'rust')} now`],
    ['code with no language', `${code('a', '')} fix`],
    ['typed literal markers', `\\[Context 1] [Context 9] ${prose('q')}`],
    [
      'quote text that looks like a label',
      `${prose('Context 1 (selected from the conversation):\n> x')} ok`
    ],
    ['a nested fence inside code', `${code('```\ninner\n```', 'md')}`]
  ]
  for (const [name, value] of cases) {
    it(`reverses the prompt to the display string losslessly (${name})`, () => {
      const display = value.trim()
      expect(selectionContextsToDisplay(serializeSelectionContexts(display))).toBe(display)
    })
  }

  it('restores a leading slash command as a command token', () => {
    const display = `${commandToken('review')} ${prose('x')} focus`
    const wire = serializeSelectionContexts(display).replace(commandToken('review'), '/review')
    expect(selectionContextsToDisplay(wire)).toBe(display)
  })

  it('undoes skill markers the skill reverse placed inside a quote', () => {
    const display = `${prose('call (lint) here')} ok`
    const wire = serializeSelectionContexts(display).replace('(lint)', skillToken('lint'))
    expect(selectionContextsToDisplay(wire)).toBe(display)
  })

  it('never turns typed text in the exact prompt shape into chips', () => {
    const typed = [
      'Context 1 (selected from the conversation):\n> x\n\n[Context 1] why',
      'Context 1 (selected from the conversation):\n> x\n\n\\[Context 1] and [Context 1]',
      'see Context 1 (selected from the conversation): [Context 2]'
    ]
    for (const text of typed) {
      const wire = serializeSelectionContexts(text)
      expect(wire).not.toBe(text)
      expect(selectionContextsToDisplay(wire)).toBe(text)
    }
  })

  it('passes through text that is not an exact selection-context prompt', () => {
    const samples = [
      'plain prompt',
      'Context 1 (selected from the conversation):\n> x\n\nno marker here',
      'Context 1 (selected from the conversation):\n> x\n\n[Context 1] [Context 1]',
      'Context 2 (selected from the conversation):\n> x\n\n[Context 2]',
      'Context 1 (selected from the conversation):\nnot quoted\n\n[Context 1]',
      'Context 1 (selected from the conversation):\n> x'
    ]
    for (const sample of samples) expect(selectionContextsToDisplay(sample)).toBe(sample)
  })
})

describe('display helpers', () => {
  it('replaces tokens with numbered markers for one-line surfaces', () => {
    expect(replaceSelectionContextsWithMarkers(`a ${prose('x')} b ${prose('y')}`)).toBe(
      'a [Context 1] b [Context 2]'
    )
  })

  it('builds a one-line truncated preview', () => {
    expect(selectionContextPreview('a\n  b   c', 10)).toBe('a b c')
    expect(selectionContextPreview('abcdefghijkl', 5)).toBe('abcd…')
  })
})
