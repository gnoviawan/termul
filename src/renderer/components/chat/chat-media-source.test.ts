import { describe, expect, it } from 'vitest'
import { chatMediaFromBlock, chatMediaFromMarkdown } from './chat-media-source'

describe('chatMediaFromMarkdown', () => {
  it.each([
    [
      'a cwd-relative image',
      'out/shot.png',
      { kind: 'image', name: 'alt', src: { from: 'path', path: '/proj/out/shot.png' } }
    ],
    [
      'a cwd-relative video',
      'out/clip.mp4',
      { kind: 'video', name: 'alt', src: { from: 'path', path: '/proj/out/clip.mp4' } }
    ],
    [
      'an absolute video',
      '/tmp/rec.webm',
      { kind: 'video', name: 'alt', src: { from: 'path', path: '/tmp/rec.webm' } }
    ],
    [
      'a file:// video with an escaped space',
      'file:///tmp/my%20clip.mov',
      { kind: 'video', name: 'alt', src: { from: 'path', path: '/tmp/my clip.mov' } }
    ],
    [
      'an https video with a query string',
      'https://cdn.example.com/v/clip.mp4?sig=abc',
      {
        kind: 'video',
        name: 'alt',
        src: { from: 'url', url: 'https://cdn.example.com/v/clip.mp4?sig=abc' }
      }
    ],
    [
      'an https image without an extension',
      'https://picsum.photos/200',
      { kind: 'image', name: 'alt', src: { from: 'url', url: 'https://picsum.photos/200' } }
    ],
    [
      'a data: image',
      'data:image/png;base64,QUJD',
      { kind: 'image', name: 'alt', src: { from: 'url', url: 'data:image/png;base64,QUJD' } }
    ],
    [
      'a data: video',
      'data:video/mp4;base64,QUJD',
      { kind: 'video', name: 'alt', src: { from: 'bytes', base64: 'QUJD', mime: 'video/mp4' } }
    ],
    [
      'a blob: URL',
      'blob:https://x/1',
      { kind: 'image', name: 'alt', src: { from: 'url', url: 'blob:https://x/1' } }
    ]
  ])('parses %s', (_label, url, expected) => {
    expect(chatMediaFromMarkdown(url, 'alt', '/proj')).toEqual(expected)
  })

  it.each([
    ['a text file', 'out/notes.txt', '/proj'],
    ['a pdf', 'out/spec.pdf', '/proj'],
    ['a relative path with no cwd', 'out/shot.png', undefined],
    ['a plain http URL', 'http://example.com/a.png', '/proj'],
    ['a remote file share', 'file://server/share/a.png', '/proj'],
    ['an empty destination', '  ', '/proj']
  ])('rejects %s', (_label, url, cwd) => {
    expect(chatMediaFromMarkdown(url, 'alt', cwd)).toBeNull()
  })
})

describe('chatMediaFromBlock', () => {
  it('reads a base64 image block as bytes', () => {
    expect(chatMediaFromBlock({ type: 'image', data: 'QUJD', mimeType: 'image/png' })).toEqual({
      kind: 'image',
      name: 'Image',
      src: { from: 'bytes', base64: 'QUJD', mime: 'image/png' }
    })
  })

  it('renders a uri-only image block (claude-agent-acp URL source) from its uri', () => {
    expect(
      chatMediaFromBlock({
        type: 'image',
        data: '',
        mimeType: 'image/png',
        uri: 'https://example.com/chart.png'
      })
    ).toEqual({
      kind: 'image',
      name: 'chart.png',
      src: { from: 'url', url: 'https://example.com/chart.png' }
    })
  })

  it('reads a file:// image block uri as a local path', () => {
    expect(chatMediaFromBlock({ type: 'image', uri: 'file:///tmp/shot.png' })).toEqual({
      kind: 'image',
      name: 'shot.png',
      src: { from: 'path', path: '/tmp/shot.png' }
    })
  })

  it('reads a resource blob with a video mime as bytes', () => {
    expect(
      chatMediaFromBlock({
        type: 'resource',
        resource: { uri: 'file:///tmp/rec.webm', mimeType: 'video/webm', blob: 'QUJD' }
      })
    ).toEqual({
      kind: 'video',
      name: 'rec.webm',
      src: { from: 'bytes', base64: 'QUJD', mime: 'video/webm' }
    })
  })

  it('reads a resource blob with an audio mime as bytes', () => {
    expect(
      chatMediaFromBlock({
        type: 'resource',
        resource: { uri: 'mem://tts', mimeType: 'audio/wav', blob: 'QUJD' }
      })
    ).toEqual({
      kind: 'audio',
      name: 'tts',
      src: { from: 'bytes', base64: 'QUJD', mime: 'audio/wav' }
    })
  })

  it('keeps a text resource as embedded text, not media', () => {
    expect(
      chatMediaFromBlock({
        type: 'resource',
        resource: { uri: 'file:///tmp/a.svg', mimeType: 'image/svg+xml', text: '<svg/>' }
      })
    ).toBeNull()
  })

  it.each([
    [
      'a local video by extension',
      { type: 'resource_link', uri: 'file:///tmp/demo.mp4', name: 'demo.mp4' },
      { kind: 'video', name: 'demo.mp4', src: { from: 'path', path: '/tmp/demo.mp4' } }
    ],
    [
      'an https video by mime',
      {
        type: 'resource_link',
        uri: 'https://cdn.example.com/stream',
        name: 'stream',
        mimeType: 'video/mp4'
      },
      { kind: 'video', name: 'stream', src: { from: 'url', url: 'https://cdn.example.com/stream' } }
    ],
    [
      'a local image by mime',
      { type: 'resource_link', uri: 'file:///tmp/a.png', name: 'a.png', mimeType: 'image/png' },
      { kind: 'image', name: 'a.png', src: { from: 'path', path: '/tmp/a.png' } }
    ]
  ])('reads a resource_link to %s', (_label, block, expected) => {
    expect(chatMediaFromBlock(block)).toEqual(expected)
  })

  it('reads a base64 audio block as bytes', () => {
    expect(chatMediaFromBlock({ type: 'audio', data: 'QUJD', mimeType: 'audio/mpeg' })).toEqual({
      kind: 'audio',
      name: 'audio',
      src: { from: 'bytes', base64: 'QUJD', mime: 'audio/mpeg' }
    })
  })

  it.each([
    ['a non-media file link', { type: 'resource_link', uri: 'file:///tmp/a.ts', name: 'a.ts' }],
    [
      'remote audio, which must not auto-load',
      { type: 'resource_link', uri: 'https://x/a.mp3', mimeType: 'audio/mpeg' }
    ],
    [
      'a local file with an image mime but no image extension',
      { type: 'resource_link', uri: 'file:///tmp/blob', mimeType: 'image/png' }
    ],
    ['an image block with neither data nor uri', { type: 'image', data: '' }],
    [
      'an audio block over the inline cap',
      { type: 'audio', data: 'A'.repeat(28 * 1024 * 1024), mimeType: 'audio/wav' }
    ]
  ])('returns null for %s', (_label, block) => {
    expect(chatMediaFromBlock(block)).toBeNull()
  })
})
