import { describe, expect, it } from 'vitest'
import { findFilePathMatches } from '@/lib/file-path-links'
import { filePathFromHref, filePathHref, remarkFilePathLinks } from './chat-markdown-file-links'

describe('chat markdown file links', () => {
  it('only linkifies path-shaped tokens', () => {
    expect(findFilePathMatches('See src/App.tsx:42 and ./main.ts')).toEqual([
      { text: 'src/App.tsx:42', start: 4 },
      { text: './main.ts', start: 23 }
    ])
    expect(findFilePathMatches('https://example.com/src/App.tsx')).toEqual([])
    expect(findFilePathMatches('(src/App.tsx:42)')).toEqual([{ text: 'src/App.tsx:42', start: 1 }])
  })

  it('encodes and decodes path markers', () => {
    const href = filePathHref('src/renderer/App.tsx:42')
    expect(filePathFromHref(href)).toBe('src/renderer/App.tsx:42')
    expect(filePathFromHref('https://example.com')).toBeNull()
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

    expect(tree.children[0].children[1]).toMatchObject({
      type: 'link',
      url: filePathHref('src/App.tsx:42')
    })
    expect(tree.children[1].url).toBe('https://example.com')
    expect(tree.children[2].type).toBe('code')
  })
})
