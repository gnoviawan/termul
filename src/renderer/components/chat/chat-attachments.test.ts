import { describe, expect, it } from 'vitest'
import {
  attachmentToBlock,
  basename,
  blockDisplayName,
  blockMimeType,
  fileExtension,
  guessMimeType,
  isImageMime,
  isTextLike,
  type PendingAttachment,
  pathToFileUrl,
  uint8ToBase64
} from './chat-attachments'

describe('fileExtension', () => {
  it('returns the lower-cased extension', () => {
    expect(fileExtension('Foo.TS')).toBe('ts')
    expect(fileExtension('a/b/c.json')).toBe('json')
  })

  it('returns empty for dotfiles and extension-less names', () => {
    expect(fileExtension('.gitignore')).toBe('')
    expect(fileExtension('Dockerfile')).toBe('')
    expect(fileExtension('trailing.')).toBe('')
  })
})

describe('basename', () => {
  it('handles both slash styles', () => {
    expect(basename('D:\\a\\b\\file.ts')).toBe('file.ts')
    expect(basename('/home/x/file.ts')).toBe('file.ts')
    expect(basename('plain.txt')).toBe('plain.txt')
  })
})

describe('isImageMime', () => {
  it('detects image mime types', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('text/plain')).toBe(false)
    expect(isImageMime(undefined)).toBe(false)
  })
})

describe('isTextLike', () => {
  it('accepts code and config by extension', () => {
    expect(isTextLike('app.tsx')).toBe(true)
    expect(isTextLike('data.json')).toBe(true)
    expect(isTextLike('notes.md')).toBe(true)
    expect(isTextLike('icon.svg')).toBe(true)
  })

  it('accepts known extension-less text files', () => {
    expect(isTextLike('Dockerfile')).toBe(true)
    expect(isTextLike('.gitignore')).toBe(true)
  })

  it('accepts by text-ish mime even with unknown extension', () => {
    expect(isTextLike('weird.xyz', 'text/plain')).toBe(true)
    expect(isTextLike('weird.xyz', 'application/json')).toBe(true)
  })

  it('rejects binaries and raster images', () => {
    expect(isTextLike('photo.png')).toBe(false)
    expect(isTextLike('doc.pdf')).toBe(false)
    expect(isTextLike('archive.zip')).toBe(false)
  })
})

describe('guessMimeType', () => {
  it('maps known extensions and defaults to text/plain', () => {
    expect(guessMimeType('a.json')).toBe('application/json')
    expect(guessMimeType('a.png')).toBe('image/png')
    expect(guessMimeType('a.unknownext')).toBe('text/plain')
  })
})

describe('pathToFileUrl', () => {
  it('converts a Windows drive path', () => {
    expect(pathToFileUrl('D:\\Projects\\a.ts')).toBe('file:///D:/Projects/a.ts')
  })

  it('keeps a unix absolute path and encodes spaces', () => {
    expect(pathToFileUrl('/home/x/my file.ts')).toBe('file:///home/x/my%20file.ts')
  })
})

describe('uint8ToBase64', () => {
  it('encodes bytes to base64', () => {
    expect(uint8ToBase64(new Uint8Array([104, 105]))).toBe('aGk=')
    expect(uint8ToBase64(new Uint8Array([]))).toBe('')
  })

  it('handles a chunk-boundary-sized buffer', () => {
    const bytes = new Uint8Array(0x8000 + 5).fill(65)
    const out = uint8ToBase64(bytes)
    expect(atob(out)).toHaveLength(bytes.length)
  })
})

describe('attachmentToBlock', () => {
  it('maps an image to an ACP image block', () => {
    const a: PendingAttachment = {
      kind: 'image',
      id: '1',
      name: 'x.png',
      mimeType: 'image/png',
      previewUrl: 'data:image/png;base64,AAA',
      base64: 'AAA'
    }
    expect(attachmentToBlock(a)).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAA' })
  })

  it('maps a path to a resource_link block', () => {
    const a: PendingAttachment = {
      kind: 'file-ref',
      id: '2',
      name: 'a.ts',
      mimeType: 'text/typescript',
      path: 'D:\\a\\a.ts'
    }
    expect(attachmentToBlock(a)).toEqual({
      type: 'resource_link',
      uri: 'file:///D:/a/a.ts',
      name: 'a.ts',
      mimeType: 'text/typescript'
    })
  })

  it('maps inline text to an embedded resource block', () => {
    const a: PendingAttachment = {
      kind: 'file-embed',
      id: '3',
      name: 'note.md',
      mimeType: 'text/markdown',
      text: '# hi',
      size: 4
    }
    expect(attachmentToBlock(a)).toEqual({
      type: 'resource',
      resource: {
        uri: 'attachment:///note.md',
        mimeType: 'text/markdown',
        text: '# hi'
      }
    })
  })
})

describe('blockDisplayName', () => {
  it('prefers explicit name/title', () => {
    expect(blockDisplayName({ type: 'resource_link', name: 'a.ts', uri: 'file:///x/a.ts' })).toBe(
      'a.ts'
    )
  })

  it('derives a basename from a resource_link uri', () => {
    expect(blockDisplayName({ type: 'resource_link', uri: 'file:///x/y/b.json' })).toBe('b.json')
  })

  it('derives a name from an embedded resource uri', () => {
    expect(
      blockDisplayName({ type: 'resource', resource: { uri: 'attachment:///note%20one.md' } })
    ).toBe('note one.md')
  })
})

describe('blockMimeType', () => {
  it('reads top-level then nested resource mime', () => {
    expect(blockMimeType({ type: 'resource_link', mimeType: 'text/typescript' })).toBe(
      'text/typescript'
    )
    expect(blockMimeType({ type: 'resource', resource: { mimeType: 'text/markdown' } })).toBe(
      'text/markdown'
    )
    expect(blockMimeType({ type: 'text', text: 'x' })).toBeUndefined()
  })
})
