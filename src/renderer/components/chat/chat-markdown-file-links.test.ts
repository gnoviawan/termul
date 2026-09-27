import { describe, expect, it } from 'vitest'
import { findFilePathMatches } from '@/lib/file-path-links'
import {
  escapeHtmlAttribute,
  remarkFilePathLinks,
  termulFilePathTag
} from './chat-markdown-file-links'

function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function dataPathOf(tag: string): string {
  const match = tag.match(/ data-path="([^"]*)"/)
  expect(match).not.toBeNull()
  return unescapeHtml(match?.[1] ?? '')
}

describe('chat markdown file links', () => {
  it('only linkifies path-shaped tokens', () => {
    expect(findFilePathMatches('See src/App.tsx:42 and ./main.ts')).toEqual([
      { text: 'src/App.tsx:42', start: 4 },
      { text: './main.ts', start: 23 }
    ])
    expect(findFilePathMatches('https://example.com/src/App.tsx')).toEqual([])
    expect(findFilePathMatches('(src/App.tsx:42)')).toEqual([{ text: 'src/App.tsx:42', start: 1 }])
    expect(findFilePathMatches('See src/App.tsx:42,')).toEqual([
      { text: 'src/App.tsx:42', start: 4 }
    ])
    expect(findFilePathMatches('(see src/App.tsx)')).toEqual([{ text: 'src/App.tsx', start: 5 }])
  })

  it('escapes HTML-special characters in emitted attributes and text', () => {
    expect(escapeHtmlAttribute('a&b<c>"d"')).toBe('a&amp;b&lt;c&gt;&quot;d&quot;')
    expect(termulFilePathTag('src/renderer/App.tsx:42')).toBe(
      '<termul-file-path data-path="src/renderer/App.tsx:42">src/renderer/App.tsx:42</termul-file-path>'
    )
  })

  it('round-trips paths containing & and " through the emitted tag', () => {
    const path = 'specs/edge&"quote".md:12'
    const tag = termulFilePathTag(path)
    expect(dataPathOf(tag)).toBe(path)
    expect(tag).not.toContain('"quote"')
  })

  it('linkifies prose paths but leaves links and code blocks unchanged', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'See src/App.tsx:42.' }] },
        {
          type: 'link',
          url: 'https://example.com',
          children: [{ type: 'text', value: 'src/App.tsx' }]
        },
        { type: 'code', value: 'src/App.tsx:42' }
      ]
    }

    remarkFilePathLinks()(tree)

    const paragraph = tree.children[0].children as Array<{ type: string; value?: string }>
    expect(paragraph).toHaveLength(3)
    expect(paragraph[0]).toMatchObject({ type: 'text', value: 'See ' })
    expect(paragraph[1]).toMatchObject({ type: 'html', value: termulFilePathTag('src/App.tsx:42') })
    expect(paragraph[2]).toMatchObject({ type: 'text', value: '.' })
    expect(tree.children[1].url).toBe('https://example.com')
    expect(tree.children[2].type).toBe('code')
  })

  it('escapes special characters in linkified prose paths', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'See docs/a&b.md:1.' }] }]
    }

    remarkFilePathLinks()(tree)

    const htmlNode = (tree.children[0].children as Array<{ type: string; value?: string }>)[1]
    expect(htmlNode.type).toBe('html')
    expect(dataPathOf(htmlNode.value ?? '')).toBe('docs/a&b.md:1')
  })
})
