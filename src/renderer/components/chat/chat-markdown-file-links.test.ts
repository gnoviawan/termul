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
    expect(findFilePathMatches('choose text/text here')).toEqual([])
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

  it('leaves prose slash-pairs unlinked beside a real path match', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'Use read/write mode and open src/App.tsx:42 now' }]
        }
      ]
    }

    remarkFilePathLinks()(tree)

    const paragraph = tree.children[0].children as Array<{ type: string; value?: string }>
    expect(paragraph).toHaveLength(3)
    expect(paragraph[0]).toMatchObject({ type: 'text', value: 'Use read/write mode and open ' })
    expect(paragraph[1]).toMatchObject({ type: 'html', value: termulFilePathTag('src/App.tsx:42') })
    expect(paragraph[2]).toMatchObject({ type: 'text', value: ' now' })
  })

  it('emits no link nodes for prose-only paragraphs', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'read/write mode' }] }]
    }

    remarkFilePathLinks()(tree)

    const paragraph = tree.children[0].children as Array<{ type: string; value?: string }>
    expect(paragraph).toHaveLength(1)
    expect(paragraph[0]).toMatchObject({ type: 'text', value: 'read/write mode' })
    expect(paragraph.filter((node) => node.type === 'html')).toHaveLength(0)
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

  describe('markdown link rewriting', () => {
    function rewriteLink(
      url: string,
      text = 'label'
    ): { type: string; value?: string; url?: string } {
      const tree = {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'link', url, children: [{ type: 'text', value: text }] }]
          }
        ]
      }
      remarkFilePathLinks()(tree)
      return tree.children[0].children[0] as { type: string; value?: string; url?: string }
    }

    it.each([
      ['file:///C:/proj/DESIGN.md', 'C:/proj/DESIGN.md'],
      ['file:///home/u/a.ts', '/home/u/a.ts'],
      ['file://localhost/home/u/a.ts', '/home/u/a.ts'],
      ['DESIGN.md', 'DESIGN.md'],
      ['./docs/a%20b.md', './docs/a b.md'],
      ['/abs/path/file.md', '/abs/path/file.md'],
      ['C:/proj/a.md', 'C:/proj/a.md'],
      ['C:\\proj\\a.md', 'C:\\proj\\a.md'],
      ['src/a.ts#L42', 'src/a.ts:42'],
      ['src/a.ts#section', 'src/a.ts'],
      ['src/a.ts#L10-L20', 'src/a.ts:10'],
      ['src/a.ts:10#L42', 'src/a.ts:10'],
      ['src/a.md?plain=1', 'src/a.md'],
      ['DESIGN.md:42', 'DESIGN.md:42']
    ])('rewrites %s to a file button for %s', (url, path) => {
      const node = rewriteLink(url)
      expect(node.type).toBe('html')
      expect(dataPathOf(node.value ?? '')).toBe(path)
    })

    it('uses the link text as the label and escapes it', () => {
      const node = rewriteLink('a.md', 'A <b> & "c"')
      expect(node.value).toBe(termulFilePathTag('a.md', 'A <b> & "c"'))
      expect(node.value).toContain('>A &lt;b&gt; &amp; &quot;c&quot;</termul-file-path>')
    })

    it('flattens inline code and emphasis in the link text into the label', () => {
      const tree = {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'link',
                url: 'src/a.ts#L10',
                children: [
                  { type: 'inlineCode', value: 'foo()' },
                  { type: 'text', value: ' in ' },
                  { type: 'strong', children: [{ type: 'text', value: 'a' }] }
                ]
              }
            ]
          }
        ]
      }
      remarkFilePathLinks()(tree)
      const node = tree.children[0].children[0] as { value?: string }
      expect(node.value).toBe(termulFilePathTag('src/a.ts:10', 'foo() in a'))
    })

    it('keeps image links (badges) as normal links', () => {
      const tree = {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'link',
                url: 'a.md',
                children: [{ type: 'image', url: 'b.png', alt: 'badge' }]
              }
            ]
          }
        ]
      }
      remarkFilePathLinks()(tree)
      expect(tree.children[0].children[0].type).toBe('link')
    })

    it('falls back to the path when the link text is empty', () => {
      expect(rewriteLink('a.md', '').value).toBe(termulFilePathTag('a.md'))
    })

    it.each([
      'https://example.com/a.md',
      'http://example.com/a.md',
      'mailto:a@b.c',
      'tel:123',
      'sms:5551234',
      'javascript:alert(1)',
      '%6Aavascript:alert(1)',
      '#sec',
      '//host/a.md',
      'file://server/share/a.md',
      'file:////server/share/a.md',
      'file://///server/share/a.md',
      'file:///%2Fserver/a.md',
      'file:///',
      'file:///a%00b.md',
      '\\\\server\\share\\a.md',
      '/\\server/a.md',
      'file:///%zz',
      '%zz',
      ''
    ])('leaves %j untouched', (url) => {
      const node = rewriteLink(url)
      expect(node.type).toBe('link')
      expect(node.url).toBe(url)
    })
  })
})
