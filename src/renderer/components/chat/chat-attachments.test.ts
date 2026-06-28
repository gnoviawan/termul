import { describe, expect, it } from 'vitest'
import {
  attachmentAriaLabel,
  attachmentToBlock,
  basename,
  blockDisplayName,
  blockMimeType,
  blockToAttachmentData,
  blockUri,
  fileExtension,
  fileUrlToPath,
  guessMimeType,
  humanizeAttachmentName,
  isImageMime,
  isLocalFileUri,
  isOpaqueAttachmentName,
  isTextLike,
  type PendingAttachment,
  pathToFileUrl,
  pendingToAttachmentData,
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

  it('humanizes guid-like basenames from uris', () => {
    expect(
      blockDisplayName({
        type: 'resource_link',
        uri: 'file:///tmp/{13A24D2D-A486-4A00-B9F6-9D9DAB699BC5}.png'
      })
    ).toBe('Image')
  })

  it('labels bare image blocks', () => {
    expect(blockDisplayName({ type: 'image', mimeType: 'image/png', data: 'abc' })).toBe('Image')
  })
})

describe('humanizeAttachmentName', () => {
  it('maps guid and generic names to Image', () => {
    expect(humanizeAttachmentName('{13A24D2D-A486-4A00-B9F6-9D9DAB699BC5}.png')).toBe('Image')
    expect(humanizeAttachmentName('image.png')).toBe('Image')
    expect(isOpaqueAttachmentName('pasted-image.png')).toBe(true)
  })

  it('maps pasted-image to Screenshot', () => {
    expect(humanizeAttachmentName('pasted-image.png')).toBe('Screenshot')
  })

  it('strips faizui temp prefix names', () => {
    expect(humanizeAttachmentName('faizui-abc-123-photo.png')).toBe('Image')
  })

  it('keeps readable filenames', () => {
    expect(humanizeAttachmentName('diagram-flow.png')).toBe('diagram-flow.png')
  })

  it('truncates long readable names', () => {
    const long = 'a-very-long-filename-that-should-truncate.png'
    expect(humanizeAttachmentName(long).endsWith('…')).toBe(true)
  })
})

describe('attachmentAriaLabel', () => {
  it('uses human label for opaque names', () => {
    expect(attachmentAriaLabel('{13A24D2D-A486-4}.png')).toBe('Image')
  })

  it('includes raw basename for readable names', () => {
    expect(attachmentAriaLabel('src/components/Foo.tsx')).toContain('Foo.tsx')
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

describe('fileUrlToPath', () => {
  it('strips the leading slash from a Windows drive path', () => {
    expect(fileUrlToPath('file:///D:/Projects/a.ts')).toBe('D:/Projects/a.ts')
  })

  it('keeps a unix absolute path', () => {
    expect(fileUrlToPath('file:///home/x/a.ts')).toBe('/home/x/a.ts')
  })

  it('returns non-file URIs unchanged', () => {
    expect(fileUrlToPath('attachment:///note.md')).toBe('attachment:///note.md')
    expect(fileUrlToPath('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
  })
})

describe('isLocalFileUri', () => {
  it('accepts file://, bare drive, and unix absolute paths', () => {
    expect(isLocalFileUri('file:///D:/a/b.ts')).toBe(true)
    expect(isLocalFileUri('D:\\a\\b.ts')).toBe(true)
    expect(isLocalFileUri('/home/x/a.ts')).toBe(true)
  })

  it('rejects data:, attachment:, http:, and undefined', () => {
    expect(isLocalFileUri('data:image/png;base64,abc')).toBe(false)
    expect(isLocalFileUri('attachment:///note.md')).toBe(false)
    expect(isLocalFileUri('http://x/y')).toBe(false)
    expect(isLocalFileUri(undefined)).toBe(false)
  })
})

describe('blockUri', () => {
  it('reads the direct uri of an image/resource_link block', () => {
    expect(blockUri({ type: 'resource_link', uri: 'file:///D:/a/b.ts' })).toBe('file:///D:/a/b.ts')
  })

  it('falls back to the nested resource uri', () => {
    expect(blockUri({ type: 'resource', resource: { uri: 'attachment:///n.md' } })).toBe(
      'attachment:///n.md'
    )
  })

  it('returns undefined when no uri is present', () => {
    expect(blockUri({ type: 'text', text: 'hi' })).toBeUndefined()
  })
})

describe('pendingToAttachmentData', () => {
  it('maps an inline image to a file part with a preview url and humanized name', () => {
    const a: PendingAttachment = {
      kind: 'image',
      id: '1',
      name: '{13A24D2D-A486-4}.png',
      mimeType: 'image/png',
      previewUrl: 'data:image/png;base64,AAA',
      base64: 'AAA'
    }
    expect(pendingToAttachmentData(a)).toEqual({
      type: 'file',
      id: '1',
      filename: 'Image',
      mediaType: 'image/png',
      url: 'data:image/png;base64,AAA'
    })
  })

  it('maps a file-ref image to a file part carrying its thumbnail url', () => {
    const a: PendingAttachment = {
      kind: 'file-ref',
      id: '2',
      name: 'photo.png',
      mimeType: 'image/png',
      path: 'D:/p/photo.png',
      previewUrl: 'data:image/png;base64,BBB'
    }
    expect(pendingToAttachmentData(a)).toEqual({
      type: 'file',
      id: '2',
      filename: 'photo.png',
      mediaType: 'image/png',
      url: 'data:image/png;base64,BBB'
    })
  })

  it('maps a non-image file-ref to a file part with an empty url', () => {
    const a: PendingAttachment = {
      kind: 'file-ref',
      id: '3',
      name: 'a.ts',
      mimeType: 'text/typescript',
      path: 'D:/a/a.ts'
    }
    expect(pendingToAttachmentData(a)).toEqual({
      type: 'file',
      id: '3',
      filename: 'a.ts',
      mediaType: 'text/typescript',
      url: ''
    })
  })

  it('maps an embedded text file to a file part with an empty url', () => {
    const a: PendingAttachment = {
      kind: 'file-embed',
      id: '4',
      name: 'notes.md',
      mimeType: 'text/markdown',
      text: '# hi',
      size: 4
    }
    expect(pendingToAttachmentData(a)).toEqual({
      type: 'file',
      id: '4',
      filename: 'notes.md',
      mediaType: 'text/markdown',
      url: ''
    })
  })
})

describe('blockToAttachmentData', () => {
  it('maps an inline image block to a renderable data url', () => {
    expect(
      blockToAttachmentData({ type: 'image', mimeType: 'image/png', data: 'AAA' }, 'i0')
    ).toEqual({
      type: 'file',
      id: 'i0',
      filename: 'Image',
      mediaType: 'image/png',
      url: 'data:image/png;base64,AAA'
    })
  })

  it('leaves file:// resource_link images empty for lazy bubble resolution', () => {
    expect(
      blockToAttachmentData(
        { type: 'resource_link', uri: 'file:///D:/a.png', name: 'a.png', mimeType: 'image/png' },
        'i1'
      )
    ).toEqual({
      type: 'file',
      id: 'i1',
      filename: 'a.png',
      mediaType: 'image/png',
      url: ''
    })
  })

  it('passes http/data urls through as renderable', () => {
    expect(
      blockToAttachmentData(
        { type: 'resource_link', uri: 'http://x/y.png', name: 'y.png', mimeType: 'image/png' },
        'i2'
      )
    ).toEqual({
      type: 'file',
      id: 'i2',
      filename: 'y.png',
      mediaType: 'image/png',
      url: 'http://x/y.png'
    })
  })

  it('maps an embedded resource to an empty-url document part', () => {
    expect(
      blockToAttachmentData(
        { type: 'resource', resource: { uri: 'attachment:///n.md', mimeType: 'text/markdown' } },
        'i3'
      )
    ).toEqual({
      type: 'file',
      id: 'i3',
      filename: 'n.md',
      mediaType: 'text/markdown',
      url: ''
    })
  })
})
