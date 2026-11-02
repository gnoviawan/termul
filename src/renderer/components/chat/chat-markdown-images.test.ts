import { describe, expect, it } from 'vitest'
import {
  parseChatMarkdownBlocks,
  remarkTermulMedia,
  resolveLocalImagePath,
  termulMediaTag
} from './chat-markdown-images'

describe('chat markdown images', () => {
  it('rewrites non-https image nodes into termul-media raw HTML', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'See ' },
            { type: 'image', url: 'data:image/png;base64,QUJD', alt: 'tiny' },
            { type: 'image', url: 'file:///E:/proj/chart.png', alt: 'chart' },
            { type: 'image', url: 'output/chart.png', alt: 'rel' }
          ]
        }
      ]
    }

    remarkTermulMedia()(tree)

    const children = tree.children[0].children.slice(1) as Array<{ type: string; value?: string }>
    expect(children).toHaveLength(3)
    expect(children[0]).toEqual({
      type: 'html',
      value: '<termul-media data-url="data:image/png;base64,QUJD" data-alt="tiny"></termul-media>'
    })
    expect(children[1]).toEqual({
      type: 'html',
      value: '<termul-media data-url="file:///E:/proj/chart.png" data-alt="chart"></termul-media>'
    })
    expect(children[2]).toEqual({
      type: 'html',
      value: '<termul-media data-url="output/chart.png" data-alt="rel"></termul-media>'
    })
  })

  it('rewrites https images too, so every markdown image gets the lightbox', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'image', url: 'https://example.com/clip.mp4', alt: 'clip' }]
        }
      ]
    }

    remarkTermulMedia()(tree)

    expect(tree.children[0].children).toEqual([
      {
        type: 'html',
        value:
          '<termul-media data-url="https://example.com/clip.mp4" data-alt="clip"></termul-media>'
      }
    ])
  })

  it('keeps media links inline and previews them after their paragraph', () => {
    const link = (url: string, text: string) => ({
      type: 'link',
      url,
      children: [{ type: 'text', value: text }]
    })
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'Watch ' },
            link('out/shot.png', 'the shot'),
            { type: 'text', value: ' then ' },
            link('file:///tmp/my%20clip.mp4', 'demo'),
            link('out/shot.png', 'again'),
            link('src/app.ts', 'code'),
            link('https://example.com/clip.mp4', 'remote')
          ]
        }
      ]
    }

    remarkTermulMedia()(tree)

    expect(tree.children).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'Watch ' },
          link('out/shot.png', 'the shot'),
          { type: 'text', value: ' then ' },
          link('file:///tmp/my%20clip.mp4', 'demo'),
          link('out/shot.png', 'again'),
          link('src/app.ts', 'code'),
          link('https://example.com/clip.mp4', 'remote')
        ]
      },
      {
        type: 'html',
        value:
          '<termul-media data-url="out/shot.png" data-alt="the shot" data-link-preview="true"></termul-media>'
      },
      {
        type: 'html',
        value:
          '<termul-media data-url="file:///tmp/my%20clip.mp4" data-alt="demo" data-link-preview="true"></termul-media>'
      }
    ])
  })

  it('previews a media link in a list item after its paragraph inside the item', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [
                    { type: 'link', url: 'clip.mp4', children: [{ type: 'text', value: 'clip' }] }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }

    remarkTermulMedia()(tree)

    expect(tree.children[0].children[0].children).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'link', url: 'clip.mp4', children: [{ type: 'text', value: 'clip' }] }]
      },
      {
        type: 'html',
        value:
          '<termul-media data-url="clip.mp4" data-alt="clip" data-link-preview="true"></termul-media>'
      }
    ])
  })

  it('previews a reference-style media link from its definition', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'linkReference',
              identifier: 'video',
              children: [{ type: 'text', value: 'clip' }]
            }
          ]
        },
        { type: 'definition', identifier: 'video', url: 'out/clip.mp4' }
      ]
    }

    remarkTermulMedia()(tree)

    expect(tree.children[1]).toEqual({
      type: 'html',
      value:
        '<termul-media data-url="out/clip.mp4" data-alt="clip" data-link-preview="true"></termul-media>'
    })
  })

  it('previews a media link without its query or fragment', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'link', url: 'clip.mp4#details', children: [{ type: 'text', value: 'clip' }] }
          ]
        }
      ]
    }

    remarkTermulMedia()(tree)

    expect(tree.children[1]).toEqual({
      type: 'html',
      value:
        '<termul-media data-url="clip.mp4" data-alt="clip" data-link-preview="true"></termul-media>'
    })
  })

  it('leaves a link that wraps an image as a link around the image', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'out/big.png',
              children: [{ type: 'image', url: 'out/thumb.png', alt: 'thumb' }]
            }
          ]
        }
      ]
    }

    remarkTermulMedia()(tree)

    expect(tree.children).toEqual([
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            url: 'out/big.png',
            children: [
              {
                type: 'html',
                value: '<termul-media data-url="out/thumb.png" data-alt="thumb"></termul-media>'
              }
            ]
          }
        ]
      }
    ])
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

    remarkTermulMedia()(tree)

    const children = tree.children[0].children as Array<{ type: string; value?: string }>
    expect(children).toHaveLength(2)
    expect(children[0]).toEqual({
      type: 'html',
      value: '<termul-media data-url="" data-alt=""></termul-media>'
    })
    expect(children[1]).toEqual({
      type: 'html',
      value: '<termul-media data-url="   " data-alt="blankish"></termul-media>'
    })
  })

  it('escapes url and alt in the emitted tag', () => {
    expect(termulMediaTag('a&b<c>.png', 'alt "&" text')).toBe(
      '<termul-media data-url="a&amp;b&lt;c&gt;.png" data-alt="alt &quot;&amp;&quot; text"></termul-media>'
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

    remarkTermulMedia()(tree)

    const listItem = tree.children[0]
    const paragraph = listItem.children[0]
    const link = paragraph.children[1]
    expect(paragraph.children[0]).toEqual({ type: 'text', value: 'see ' })
    expect(link.children[0]).toEqual({
      type: 'html',
      value: '<termul-media data-url="blob:https://x/1" data-alt="linked"></termul-media>'
    })
    expect(listItem.children[1]).toEqual({
      type: 'html',
      value: '<termul-media data-url="data:image/gif;base64,QQ" data-alt=""></termul-media>'
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

type Node = { type: string; [key: string]: unknown }

const image = (url: string, alt: string): Node => ({ type: 'image', url, alt })
const text = (value: string): Node => ({ type: 'text', value })
const paragraph = (...children: Node[]): Node => ({ type: 'paragraph', children })

function transform(...children: Node[]): Node[] {
  const tree = { type: 'root', children }
  remarkTermulMedia()(tree)
  return tree.children
}

function gallery(...items: Array<[url: string, alt: string]>): Node {
  const json = JSON.stringify(items.map(([url, alt]) => ({ url, alt }))).replaceAll('"', '&quot;')
  return { type: 'html', value: `<termul-gallery data-items="${json}"></termul-gallery>` }
}

function media(url: string, alt: string): Node {
  return { type: 'html', value: termulMediaTag(url, alt) }
}

describe('chat markdown image galleries', () => {
  it('groups images on one line into one strip', () => {
    expect(
      transform(paragraph(image('a.png', 'a'), text(' '), image('https://x.test/b.png', 'b')))
    ).toEqual([gallery(['a.png', 'a'], ['https://x.test/b.png', 'b'])])
  })

  it('groups image-only paragraphs and soft breaks into one strip', () => {
    expect(
      transform(
        paragraph(image('a.png', 'a'), text('\n'), image('b.png', 'b')),
        paragraph(image('c.png', 'c')),
        paragraph(image('d.png', 'd'), { type: 'break' })
      )
    ).toEqual([gallery(['a.png', 'a'], ['b.png', 'b'], ['c.png', 'c'], ['d.png', 'd'])])
  })

  it('keeps two images split by a text paragraph as two single images', () => {
    expect(
      transform(
        paragraph(image('a.png', 'a')),
        paragraph(text('Between')),
        paragraph(image('b.png', 'b'))
      )
    ).toEqual([
      paragraph(media('a.png', 'a')),
      paragraph(text('Between')),
      paragraph(media('b.png', 'b'))
    ])
  })

  it('keeps images that share a paragraph with text inline', () => {
    expect(
      transform(paragraph(text('See '), image('a.png', 'a'), text(' and '), image('b.png', 'b')))
    ).toEqual([paragraph(text('See '), media('a.png', 'a'), text(' and '), media('b.png', 'b'))])
  })

  it('leaves a lone image inline at its own size', () => {
    expect(transform(paragraph(image('a.png', 'a')))).toEqual([paragraph(media('a.png', 'a'))])
  })

  it('keeps videos out of a strip, so a video breaks the run', () => {
    expect(
      transform(
        paragraph(image('a.png', 'a')),
        paragraph(image('https://cdn.test/clip.mp4', 'clip')),
        paragraph(image('data:video/webm;base64,QQ', 'rec')),
        paragraph(image('b.png', 'b'))
      )
    ).toEqual([
      paragraph(media('a.png', 'a')),
      paragraph(media('https://cdn.test/clip.mp4', 'clip')),
      paragraph(media('data:video/webm;base64,QQ', 'rec')),
      paragraph(media('b.png', 'b'))
    ])
  })

  it('groups reference images through their definitions', () => {
    const definition = (identifier: string, url: string): Node => ({
      type: 'definition',
      identifier,
      url
    })
    const ref = (identifier: string, alt: string): Node => ({
      type: 'imageReference',
      identifier,
      alt
    })
    expect(
      transform(
        paragraph(ref('r', 'a'), text(' '), ref('s', 'b')),
        definition('r', 'a.png'),
        definition('s', 'b.png')
      )
    ).toEqual([
      gallery(['a.png', 'a'], ['b.png', 'b']),
      definition('r', 'a.png'),
      definition('s', 'b.png')
    ])
  })

  it('leaves an undefined reference as text, which breaks the run', () => {
    expect(transform(paragraph(image('a.png', 'a')), paragraph(text('![b][missing]')))).toEqual([
      paragraph(media('a.png', 'a')),
      paragraph(text('![b][missing]'))
    ])
  })

  it('never groups media link previews', () => {
    const link = (url: string, label: string): Node => ({
      type: 'link',
      url,
      children: [text(label)]
    })
    expect(transform(paragraph(link('a.png', 'a')), paragraph(link('b.png', 'b')))).toEqual([
      paragraph(link('a.png', 'a')),
      {
        type: 'html',
        value:
          '<termul-media data-url="a.png" data-alt="a" data-link-preview="true"></termul-media>'
      },
      paragraph(link('b.png', 'b')),
      {
        type: 'html',
        value:
          '<termul-media data-url="b.png" data-alt="b" data-link-preview="true"></termul-media>'
      }
    ])
  })

  it('skips a still-streaming image: it neither counts nor breaks the run', () => {
    const incomplete = image('streamdown:incomplete-image', 'c')
    expect(
      transform(
        paragraph(image('a.png', 'a')),
        paragraph(incomplete),
        paragraph(image('b.png', 'b'), text(' '), incomplete)
      )
    ).toEqual([gallery(['a.png', 'a'], ['b.png', 'b'])])
  })

  it('leaves a still-streaming image as it is when no strip forms', () => {
    expect(
      transform(
        paragraph(image('a.png', 'a')),
        paragraph(image('streamdown:incomplete-image', 'b'))
      )
    ).toEqual([
      paragraph(media('a.png', 'a')),
      paragraph(media('streamdown:incomplete-image', 'b'))
    ])
  })

  it('groups a run inside a list item', () => {
    const item = {
      type: 'listItem',
      children: [paragraph(image('a.png', 'a'), image('b.png', 'b'))]
    }
    const [list] = transform({ type: 'list', children: [item] })
    expect(list).toEqual({
      type: 'list',
      children: [
        {
          type: 'listItem',
          children: [gallery(['a.png', 'a'], ['b.png', 'b'])]
        }
      ]
    })
  })
})

describe('parseChatMarkdownBlocks', () => {
  it('joins image-only blocks so a streamed run renders as one strip', () => {
    expect(
      parseChatMarkdownBlocks('Intro\n\n![a](a.png)\n\n![b](b.png) ![c](c.png)\n\nOutro')
    ).toEqual(['Intro\n\n', '![a](a.png)\n\n![b](b.png) ![c](c.png)\n\n', 'Outro'])
  })

  it('joins image blocks whose destinations hold balanced parentheses', () => {
    expect(parseChatMarkdownBlocks('![a](out/File_(1).png)\n\n![b](out/File_(2).png)')).toEqual([
      '![a](out/File_(1).png)\n\n![b](out/File_(2).png)'
    ])
  })

  it('keeps image blocks split by text apart', () => {
    expect(parseChatMarkdownBlocks('![a](a.png)\n\nBetween\n\n![b](b.png)')).toEqual([
      '![a](a.png)\n\n',
      'Between\n\n',
      '![b](b.png)'
    ])
  })

  it('does not join a paragraph that mixes images and text', () => {
    expect(parseChatMarkdownBlocks('![a](a.png)\n\nSee ![b](b.png)')).toEqual([
      '![a](a.png)\n\n',
      'See ![b](b.png)'
    ])
  })

  it('joins a streamed image once its destination is complete', () => {
    expect(parseChatMarkdownBlocks('![a](a.png)\n\n![b](b.p')).toEqual([
      '![a](a.png)\n\n',
      '![b](b.p'
    ])
    expect(parseChatMarkdownBlocks('![a](a.png)\n\n![b](b.png)')).toEqual([
      '![a](a.png)\n\n![b](b.png)'
    ])
  })
})
