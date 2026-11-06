/**
 * Executable coverage for copyAttachmentImage (spec-bug-report-dialog).
 *
 * The ReportBugDialog suite mocks this module, so the real paths are tested
 * here: byte-source selection (inline base64 vs `readMediaBytes` for
 * file-refs), the PNG sniff/passthrough vs the canvas re-encode (jsdom has
 * no canvas or image decode — both are stubbed), the Tauri
 * `writeClipboardImagePng` channel vs the web `navigator.clipboard.write` +
 * `ClipboardItem` channel, and the no-channel rejection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readMediaBytes: vi.fn(),
  writeClipboardImagePng: vi.fn(),
  isTauriContext: vi.fn(() => true),
  logFrontendError: vi.fn(async () => undefined),
  clipboardWrite: vi.fn(),
  drawImage: vi.fn(),
  getContext: vi.fn(),
  toDataURL: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
  // jsdom's Blob has no arrayBuffer() — capture constructor parts instead so
  // tests can assert the exact bytes the clipboard Blob wraps.
  blobParts: [] as BlobPart[][]
}))

vi.mock('@/lib/media-bytes-api', () => ({
  readMediaBytes: mocks.readMediaBytes
}))
vi.mock('@/lib/composer-attachments-io', () => ({
  writeClipboardImagePng: mocks.writeClipboardImagePng
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: mocks.isTauriContext
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: mocks.logFrontendError
}))

import type { PendingAttachment } from '@/components/chat/chat-attachments'
import { copyAttachmentImage } from './copy-attachment-image'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 10, 20, 30])
// What the fake canvas "encodes" — a different byte string than the input so
// tests can tell passthrough from re-encode.
const REENCODED_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 99, 98, 97])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 4, 6])

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function imageAttachment(overrides: Partial<Extract<PendingAttachment, { kind: 'image' }>> = {}) {
  return {
    kind: 'image' as const,
    id: 'att-1',
    name: 'shot.png',
    mimeType: 'image/png',
    previewUrl: 'data:image/png;base64,AAA=',
    base64: toBase64(PNG_BYTES),
    ...overrides
  }
}

/** jsdom never fires `img.onload` for blob URLs — this double resolves it. */
class FakeImage {
  onload: (() => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  naturalWidth = 7
  naturalHeight = 5
  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

/** Minimal ClipboardItem stand-in: captures the {mime: Blob} init map. */
class FakeClipboardItem {
  items: Record<string, Blob>
  constructor(items: Record<string, Blob>) {
    this.items = items
  }
}

/** Blob subclass recording constructor parts (jsdom lacks blob.arrayBuffer). */
const SpyBlob = class extends Blob {
  constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options)
    mocks.blobParts.push(parts ?? [])
  }
}

function stubClipboardWrite(): void {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { write: mocks.clipboardWrite }
  })
}

function stubReencode(): void {
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: mocks.getContext,
    toDataURL: mocks.toDataURL
  }
  const realCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) =>
    tagName === 'canvas'
      ? fakeCanvas
      : realCreateElement(tagName)) as typeof document.createElement)
}

const mutableURL = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }

describe('copyAttachmentImage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isTauriContext.mockReturnValue(true)
    mocks.writeClipboardImagePng.mockResolvedValue(undefined)
    mocks.readMediaBytes.mockResolvedValue({
      success: true,
      data: { arrayBuffer: async () => PNG_BYTES.slice().buffer }
    })
    mocks.clipboardWrite.mockResolvedValue(undefined)
    mocks.getContext.mockReturnValue({ drawImage: mocks.drawImage })
    mocks.toDataURL.mockReturnValue(`data:image/png;base64,${toBase64(REENCODED_PNG)}`)
    mocks.createObjectURL.mockReturnValue('blob:mock')
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    vi.stubGlobal('Blob', SpyBlob)
    mocks.blobParts.length = 0
    mutableURL.createObjectURL = mocks.createObjectURL
    mutableURL.revokeObjectURL = mocks.revokeObjectURL
    stubClipboardWrite()
    stubReencode()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete mutableURL.createObjectURL
    delete mutableURL.revokeObjectURL
    delete (window.navigator as { clipboard?: unknown }).clipboard
  })

  it('passes inline base64 PNG bytes to the Tauri clipboard channel untouched', async () => {
    await copyAttachmentImage(imageAttachment())

    expect(mocks.readMediaBytes).not.toHaveBeenCalled()
    expect(mocks.writeClipboardImagePng).toHaveBeenCalledTimes(1)
    expect(mocks.writeClipboardImagePng).toHaveBeenCalledWith(PNG_BYTES)
    // PNG bytes skip the canvas re-encode entirely.
    expect(mocks.createObjectURL).not.toHaveBeenCalled()
    expect(mocks.toDataURL).not.toHaveBeenCalled()
    expect(mocks.clipboardWrite).not.toHaveBeenCalled()
  })

  it('reads a file-ref attachment through readMediaBytes', async () => {
    const att: PendingAttachment = {
      kind: 'file-ref',
      id: 'att-2',
      name: 'shot.png',
      mimeType: 'image/png',
      path: '/tmp/shots/one.png'
    }
    await copyAttachmentImage(att)

    expect(mocks.readMediaBytes).toHaveBeenCalledWith('/tmp/shots/one.png')
    expect(mocks.writeClipboardImagePng).toHaveBeenCalledWith(PNG_BYTES)
  })

  it('rejects with the read error when the file-ref cannot be read', async () => {
    mocks.readMediaBytes.mockResolvedValueOnce({
      success: false,
      error: 'file not found',
      code: 'NOT_FOUND'
    })
    const att: PendingAttachment = {
      kind: 'file-ref',
      id: 'att-2',
      name: 'shot.png',
      mimeType: 'image/png',
      path: '/tmp/shots/gone.png'
    }

    await expect(copyAttachmentImage(att)).rejects.toThrow('file not found')
    expect(mocks.writeClipboardImagePng).not.toHaveBeenCalled()
  })

  it('rejects a non-image attachment kind', async () => {
    const att: PendingAttachment = {
      kind: 'file-embed',
      id: 'att-3',
      name: 'notes.txt',
      mimeType: 'text/plain',
      text: 'hello',
      size: 5
    }
    await expect(copyAttachmentImage(att)).rejects.toThrow('Only image attachments')
    expect(mocks.writeClipboardImagePng).not.toHaveBeenCalled()
  })

  it('re-encodes a non-PNG image through the canvas before writing', async () => {
    await copyAttachmentImage(
      imageAttachment({ mimeType: 'image/jpeg', base64: toBase64(JPEG_BYTES) })
    )

    expect(mocks.createObjectURL).toHaveBeenCalledTimes(1)
    expect(mocks.toDataURL).toHaveBeenCalledWith('image/png')
    expect(mocks.drawImage).toHaveBeenCalled()
    // The channel receives the re-encoded PNG bytes, never the JPEG input.
    expect(mocks.writeClipboardImagePng).toHaveBeenCalledWith(REENCODED_PNG)
  })

  it('re-encodes when the mime says PNG but the magic bytes say otherwise', async () => {
    await copyAttachmentImage(imageAttachment({ base64: toBase64(JPEG_BYTES) }))

    expect(mocks.toDataURL).toHaveBeenCalledWith('image/png')
    expect(mocks.writeClipboardImagePng).toHaveBeenCalledWith(REENCODED_PNG)
  })

  it('skips the re-encode when the bytes are PNG even under a wrong mime label', async () => {
    await copyAttachmentImage(
      imageAttachment({ mimeType: 'image/jpeg', base64: toBase64(PNG_BYTES) })
    )

    expect(mocks.createObjectURL).not.toHaveBeenCalled()
    expect(mocks.writeClipboardImagePng).toHaveBeenCalledWith(PNG_BYTES)
  })

  it('writes a PNG ClipboardItem via navigator.clipboard.write on web', async () => {
    mocks.isTauriContext.mockReturnValue(false)

    await copyAttachmentImage(imageAttachment())

    expect(mocks.writeClipboardImagePng).not.toHaveBeenCalled()
    expect(mocks.clipboardWrite).toHaveBeenCalledTimes(1)
    const items = mocks.clipboardWrite.mock.calls[0][0] as FakeClipboardItem[]
    expect(items).toHaveLength(1)
    const blob = items[0].items['image/png']
    expect(blob.type).toBe('image/png')
    // The Blob was constructed around the PNG bytes verbatim.
    expect(mocks.blobParts.at(-1)).toEqual([PNG_BYTES])
  })

  it('falls back to navigator.clipboard.write when the Tauri channel fails', async () => {
    mocks.writeClipboardImagePng.mockRejectedValue(new Error('writeImage unsupported'))

    await copyAttachmentImage(imageAttachment())

    expect(mocks.writeClipboardImagePng).toHaveBeenCalledTimes(1)
    expect(mocks.clipboardWrite).toHaveBeenCalledTimes(1)
  })

  it('propagates a navigator.clipboard.write rejection (and logs no bytes)', async () => {
    mocks.isTauriContext.mockReturnValue(false)
    mocks.clipboardWrite.mockRejectedValue(new Error('denied'))

    await expect(copyAttachmentImage(imageAttachment())).rejects.toThrow('denied')
    const logged = mocks.logFrontendError.mock.calls
      .map((call) => String(call[0]?.message ?? ''))
      .join('\n')
    expect(logged).not.toContain(toBase64(PNG_BYTES))
  })

  it('rejects when no image clipboard channel is available', async () => {
    mocks.isTauriContext.mockReturnValue(false)
    delete (window.navigator as { clipboard?: unknown }).clipboard

    await expect(copyAttachmentImage(imageAttachment())).rejects.toThrow(
      'No image clipboard channel is available'
    )
    expect(mocks.clipboardWrite).not.toHaveBeenCalled()
  })
})
