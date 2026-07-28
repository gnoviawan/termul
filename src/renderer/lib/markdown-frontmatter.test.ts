import { describe, expect, it } from 'vitest'
import {
  composeFullMarkdown,
  type FrontmatterMap,
  formatFrontmatterValue,
  isFrontmatterNested,
  parseScalarInput,
  rejoinFrontmatter,
  serializeFrontmatter,
  splitFrontmatter
} from './markdown-frontmatter'

describe('splitFrontmatter', () => {
  it('happy path: valid YAML map + body → data, body-only', () => {
    const text = `---
title: Hello
status: draft
count: 3
published: true
empty: null
---
# Heading

Body paragraph.
`
    const result = splitFrontmatter(text)
    expect(result.hasFrontmatter).toBe(true)
    expect(result.data).toEqual({
      title: 'Hello',
      status: 'draft',
      count: 3,
      published: true,
      empty: null
    })
    expect(result.body).toBe('# Heading\n\nBody paragraph.\n')
  })

  it('no frontmatter: body-only markdown unchanged', () => {
    const text = '# Just a doc\n\nNo fences here.\n'
    const result = splitFrontmatter(text)
    expect(result.hasFrontmatter).toBe(false)
    expect(result.data).toEqual({})
    expect(result.body).toBe(text)
  })

  it('invalid YAML between fences → no frontmatter; full text as body', () => {
    const text = `---
title: [unclosed
broken: *
---
# Still here
`
    const result = splitFrontmatter(text)
    expect(result.hasFrontmatter).toBe(false)
    expect(result.body).toBe(text)
  })

  it('missing closing fence → no frontmatter; full text as body', () => {
    const text = `---
title: Incomplete
status: open

# Body that looks like markdown
`
    const result = splitFrontmatter(text)
    expect(result.hasFrontmatter).toBe(false)
    expect(result.body).toBe(text)
  })

  it('array values: string[] preserved; mixed arrays become nested', () => {
    const text = `---
context:
  - alpha
  - beta
mixed:
  - a
  - 1
---
Body
`
    const result = splitFrontmatter(text)
    expect(result.hasFrontmatter).toBe(true)
    expect(result.data.context).toEqual(['alpha', 'beta'])
    expect(isFrontmatterNested(result.data.mixed)).toBe(true)
    if (isFrontmatterNested(result.data.mixed)) {
      expect(result.data.mixed.display.length).toBeGreaterThan(0)
      expect(result.data.mixed.value).toEqual(['a', 1])
    }
  })

  it('nested objects become non-editable nested display values', () => {
    const text = `---
title: Root
meta:
  author: Ada
  rev: 2
---
Body
`
    const result = splitFrontmatter(text)
    expect(result.hasFrontmatter).toBe(true)
    expect(result.data.title).toBe('Root')
    expect(isFrontmatterNested(result.data.meta)).toBe(true)
    if (isFrontmatterNested(result.data.meta)) {
      expect(result.data.meta.display).toContain('author')
    }
  })

  it('root YAML array is not treated as frontmatter', () => {
    const text = `---
- a
- b
---
Body
`
    const result = splitFrontmatter(text)
    expect(result.hasFrontmatter).toBe(false)
    expect(result.body).toBe(text)
  })

  it('empty frontmatter block is valid', () => {
    const text = `---
---
# Body
`
    const result = splitFrontmatter(text)
    expect(result.hasFrontmatter).toBe(true)
    expect(result.data).toEqual({})
    expect(result.body).toBe('# Body\n')
  })

  it('strips UTF-8 BOM before fence detection', () => {
    const text = `\uFEFF---
title: Bommed
---
# Body
`
    const result = splitFrontmatter(text)
    expect(result.hasFrontmatter).toBe(true)
    expect(result.data.title).toBe('Bommed')
    expect(result.body).toBe('# Body\n')
  })
})

describe('serializeFrontmatter / rejoinFrontmatter', () => {
  it('add / remove property via serialize updates rejoined YAML', () => {
    const data: FrontmatterMap = {
      title: 'Doc',
      status: 'draft'
    }
    const withAdded: FrontmatterMap = {
      ...data,
      type: 'feature'
    }
    const added = serializeFrontmatter(withAdded)
    expect(added).not.toBeNull()
    expect(added).toContain('type: feature')
    expect(added).toContain('title: Doc')

    const { status: _removed, ...withoutStatus } = withAdded
    const removed = serializeFrontmatter(withoutStatus)
    expect(removed).not.toBeNull()
    expect(removed).not.toContain('status:')
    expect(removed).toContain('type: feature')
  })

  it('array values serialize; empty array → []', () => {
    const withItems = serializeFrontmatter({ context: ['a', 'b'] })
    expect(withItems).not.toBeNull()
    expect(withItems).toMatch(/context:\s*\n\s+- a\s*\n\s+- b/)

    const empty = serializeFrontmatter({ context: [] })
    expect(empty).not.toBeNull()
    expect(empty).toContain('context:')
    expect(empty).toMatch(/context:\s*\[\]/)
  })

  it('rejoin on body / FM edit conceptually: FM + body', () => {
    const data: FrontmatterMap = { title: 'Hello', status: 'open' }
    const body = '# Heading\n\nUpdated body.\n'
    const full = rejoinFrontmatter(data, body)
    expect(full).not.toBeNull()
    expect(full!.startsWith('---\n')).toBe(true)
    expect(full).toContain('title: Hello')
    expect(full!.endsWith(body)).toBe(true)

    const editedFm = rejoinFrontmatter({ ...data, status: 'done' }, body)
    expect(editedFm).toContain('status: done')
    expect(editedFm).toContain('# Heading')

    const editedBody = rejoinFrontmatter(data, '# New\n')
    expect(editedBody).toContain('title: Hello')
    expect(editedBody!.endsWith('# New\n')).toBe(true)
  })

  it('mode-switch / reload via re-parse: round-trip preserves editable map', () => {
    const original = `---
title: Round trip
review_loop_iteration: 2
context:
  - one
  - two
published: false
---
## Section

Content here.
`
    const first = splitFrontmatter(original)
    expect(first.hasFrontmatter).toBe(true)

    const rejoined = rejoinFrontmatter(first.data, first.body)
    expect(rejoined).not.toBeNull()
    const second = splitFrontmatter(rejoined!)
    expect(second.hasFrontmatter).toBe(true)
    expect(second.data.title).toBe('Round trip')
    expect(second.data.review_loop_iteration).toBe(2)
    expect(second.data.context).toEqual(['one', 'two'])
    expect(second.data.published).toBe(false)
    expect(second.body).toBe(first.body)
  })

  it('nested values serialize compactly from preserved value', () => {
    const split = splitFrontmatter(`---
meta:
  a: 1
  b: two
---
Body
`)
    expect(split.hasFrontmatter).toBe(true)
    const rejoined = rejoinFrontmatter(split.data, split.body)
    expect(rejoined).not.toBeNull()
    const again = splitFrontmatter(rejoined!)
    expect(again.hasFrontmatter).toBe(true)
    expect(isFrontmatterNested(again.data.meta)).toBe(true)
    if (isFrontmatterNested(again.data.meta)) {
      expect(again.data.meta.value).toEqual({ a: 1, b: 'two' })
    }
  })

  it('empty map serializes to empty fences', () => {
    expect(serializeFrontmatter({})).toBe('---\n---\n')
  })

  it('composeFullMarkdown returns body-only when no FM', () => {
    expect(composeFullMarkdown(false, { title: 'x' }, '# Body\n')).toBe('# Body\n')
  })

  it('composeFullMarkdown rejoins when FM present', () => {
    const full = composeFullMarkdown(true, { title: 'Hi' }, '# Body\n')
    expect(full).not.toBeNull()
    expect(full).toContain('title: Hi')
    expect(full!.endsWith('# Body\n')).toBe(true)
  })
})

describe('scalar helpers', () => {
  it('formatFrontmatterValue and parseScalarInput round-trip common scalars', () => {
    expect(formatFrontmatterValue(null)).toBe('null')
    expect(formatFrontmatterValue(true)).toBe('true')
    expect(formatFrontmatterValue(42)).toBe('42')
    expect(formatFrontmatterValue('hi')).toBe('hi')

    expect(parseScalarInput('null')).toBe(null)
    expect(parseScalarInput('true')).toBe(true)
    expect(parseScalarInput('false')).toBe(false)
    expect(parseScalarInput('3.5')).toBe(3.5)
    expect(parseScalarInput('42')).toBe(42)
    expect(parseScalarInput('hello')).toBe('hello')
  })

  it('preserves leading-zero digit strings as strings', () => {
    expect(parseScalarInput('007')).toBe('007')
    expect(parseScalarInput('00')).toBe('00')
    expect(parseScalarInput('0')).toBe(0)
    expect(parseScalarInput('0.5')).toBe(0.5)
  })
})
