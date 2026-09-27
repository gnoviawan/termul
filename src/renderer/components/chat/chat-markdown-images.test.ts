import { describe, expect, it } from 'vitest'
import { remarkTermulImages, resolveLocalImagePath, termulImageTag } from './chat-markdown-images'

describe('chat markdown images', () => {
  it('rewrites non-https image nodes into termul-image raw HTML', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'image', url: 'data:image/png;base64,QUJD', alt: 'tiny' },
            { type: 'image', url: 'file:///E:/proj/chart.png', alt: 'chart' },
            { type: 'image', url: 'output/chart.png', alt: 'rel' }
          ]
        }
      ]
    }

    remarkTermulImages()(tree)

    const children = tree.children[0].children as Array<{ type: string; value?: string }>
    expect(children).toHaveLength(3)
    expect(children[0]).toEqual({
      type: 'html',
      value: '<termul-image data-url="data:image/png;base64,QUJD" data-alt="tiny"></termul-image>'
    })
    expect(children[1]).toEqual({
      type: 'html',
      value: '<termul-image data-url="file:///E:/proj/chart.png" data-alt="chart"></termul-image>'
    })
    expect(children[2]).toEqual({
      type: 'html',
      value: '<termul-image data-url="output/chart.png" data-alt="rel"></termul-image>'
    })
  })

  it('leaves http and https images untouched', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'image', url: 'https://example.com/logo.png', alt: 'logo' },
            { type: 'image', url: 'http://example.com/logo.png', alt: 'logo' }
          ]
        }
      ]
    }

    remarkTermulImages()(tree)

    const children = tree.children[0].children as Array<{ type: string; url?: string }>
    expect(children).toHaveLength(2)
    expect(children[0]).toEqual({ type: 'image', url: 'https://example.com/logo.png', alt: 'logo' })
    expect(children[1]).toEqual({ type: 'image', url: 'http://example.com/logo.png', alt: 'logo' })
  })

  it('rewrites empty-destination image nodes', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'image', url: '', alt: '' },
            { type: 'image', url: '   ', alt: 'blankish' }
          ]
        }
      ]
    }

    remarkTermulImages()(tree)

    const children = tree.children[0].children as Array<{ type: string; value?: string }>
    expect(children).toHaveLength(2)
    expect(children[0]).toEqual({
      type: 'html',
      value: '<termul-image data-url="" data-alt=""></termul-image>'
    })
    expect(children[1]).toEqual({
      type: 'html',
      value: '<termul-image data-url="   " data-alt="blankish"></termul-image>'
    })
  })

  it('escapes url and alt in the emitted tag', () => {
    expect(termulImageTag('a&b<c>.png', 'alt "&" text')).toBe(
      '<termul-image data-url="a&amp;b&lt;c&gt;.png" data-alt="alt &quot;&amp;&quot; text"></termul-image>'
    )
  })

  it('rewrites images nested in any parent, not just paragraphs', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'listItem',
          children: [
            {
              type: 'paragraph',
              children: [
                { type: 'text', value: 'see ' },
                {
                  type: 'link',
                  url: 'https://example.com',
                  children: [{ type: 'image', url: 'blob:https://x/1', alt: 'linked' }]
                }
              ]
            },
            { type: 'image', url: 'data:image/gif;base64,QQ', alt: null }
          ]
        }
      ]
    }

    remarkTermulImages()(tree)

    const listItem = tree.children[0]
    const paragraph = listItem.children[0]
    const link = paragraph.children[1]
    expect(paragraph.children[0]).toEqual({ type: 'text', value: 'see ' })
    expect(link.children[0]).toEqual({
      type: 'html',
      value: '<termul-image data-url="blob:https://x/1" data-alt="linked"></termul-image>'
    })
    expect(listItem.children[1]).toEqual({
      type: 'html',
      value: '<termul-image data-url="data:image/gif;base64,QQ" data-alt=""></termul-image>'
    })
  })

  describe('resolveLocalImagePath', () => {
    it('resolves file:// URLs to OS paths', () => {
      expect(resolveLocalImagePath('file:///E:/proj/chart.png')).toBe('E:/proj/chart.png')
      expect(resolveLocalImagePath('file:///home/u/chart.png')).toBe('/home/u/chart.png')
    })

    it('joins relative paths against the cwd', () => {
      expect(resolveLocalImagePath('output/chart.png', 'E:\\proj')).toBe('E:/proj/output/chart.png')
      expect(resolveLocalImagePath('./chart.png', '/home/u')).toBe('/home/u/chart.png')
      expect(resolveLocalImagePath('../assets/x.png', '/home/u/app')).toBe('/home/u/assets/x.png')
    })

    it('keeps bare absolute paths and rejects other schemes or missing cwd', () => {
      expect(resolveLocalImagePath('/abs/chart.png')).toBe('/abs/chart.png')
      expect(resolveLocalImagePath('E:\\abs\\chart.png')).toBe('E:/abs/chart.png')
      expect(resolveLocalImagePath('attachment:///x.png', '/home/u')).toBeNull()
      expect(resolveLocalImagePath('output/chart.png')).toBeNull()
    })

    it('returns null for malformed percent escapes without throwing', () => {
      expect(() => resolveLocalImagePath('file:///%zz', '/home/u')).not.toThrow()
      expect(resolveLocalImagePath('file:///%zz', '/home/u')).toBeNull()
      expect(resolveLocalImagePath('output/%zz.png', '/home/u')).toBeNull()
      expect(resolveLocalImagePath('%zz', '/home/u')).toBeNull()
    })

    it('percent-decodes markdown URLs before resolving', () => {
      expect(resolveLocalImagePath('output/my%20chart.png', '/home/u')).toBe(
        '/home/u/output/my chart.png'
      )
      expect(resolveLocalImagePath('file:///E:/my%20chart.png')).toBe('E:/my chart.png')
      expect(resolveLocalImagePath('file:///home/u/my%20chart.png')).toBe('/home/u/my chart.png')
    })

    it('guards non-local URL shapes', () => {
      expect(resolveLocalImagePath('//example.com/x.png', '/home/u')).toBeNull()
      expect(resolveLocalImagePath('file://server/share/x.png', '/home/u')).toBeNull()
      expect(resolveLocalImagePath('FILE://Server/share/x.png', '/home/u')).toBeNull()
      expect(resolveLocalImagePath('\\\\server\\share\\x.png', '/home/u')).toBeNull()
      expect(resolveLocalImagePath('', '/home/u')).toBeNull()
      expect(resolveLocalImagePath('   ', '/home/u')).toBeNull()
      expect(resolveLocalImagePath('file://', '/home/u')).toBeNull()
    })

    it('matches the file:// prefix case-insensitively', () => {
      expect(resolveLocalImagePath('FILE:///E:/x.png')).toBe('E:/x.png')
      expect(resolveLocalImagePath('File:///home/u/x.png')).toBe('/home/u/x.png')
    })
  })
})
