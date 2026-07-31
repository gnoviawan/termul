import { describe, expect, it } from 'vitest'
import { filePathFromHref, filePathHref, remarkFilePathLinks } from './chat-markdown-file-links'

describe('chat markdown file links', () => {
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
