import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  isTauriContextMock,
  saveFileMock,
  writeFileMock,
  readMediaBytesMock,
  requestExternalLinkOpenMock
} = vi.hoisted(() => ({
  isTauriContextMock: vi.fn(() => false),
  saveFileMock: vi.fn(),
  writeFileMock: vi.fn(() => Promise.resolve()),
  readMediaBytesMock: vi.fn(),
  requestExternalLinkOpenMock: vi.fn(() => true)
}))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => isTauriContextMock() }))
vi.mock('@/lib/dialog-api', () => ({
  dialogApi: { saveFile: (...args: unknown[]) => saveFileMock(...args) }
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: (...args: unknown[]) => writeFileMock(...args)
}))
vi.mock('@/lib/media-bytes-api', () => ({
  readMediaBytes: (...args: unknown[]) => readMediaBytesMock(...args)
}))
vi.mock('@/components/external-link/ExternalLinkConfirm', () => ({
  requestExternalLinkOpen: (...args: unknown[]) => requestExternalLinkOpenMock(...args)
}))

import { downloadImage, imageFileName } from './image-download'

const mutableURL = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }
const ABC = new Uint8Array([65, 66, 67])

// jsdom's Blob predates `arrayBuffer()`; every browser and webview has it.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}

async function blobBytes(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())]
}

describe('downloadImage', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let clicked: Array<{ href: string; download: string }>
  let created: Blob[]

  beforeEach(() => {
    isTauriContextMock.mockReturnValue(false)
    saveFileMock.mockReset()
    writeFileMock.mockClear()
    readMediaBytesMock.mockReset()
    requestExternalLinkOpenMock.mockReset()
    requestExternalLinkOpenMock.mockReturnValue(true)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    created = []
    mutableURL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob)
      return 'blob:termul/download'
    })
    mutableURL.revokeObjectURL = vi.fn()
    clicked = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push({ href: this.href, download: this.download })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete mutableURL.createObjectURL
    delete mutableURL.revokeObjectURL
  })

  describe('web', () => {
    it('downloads inline bytes through an anchor and revokes the URL after a delay', async () => {
      const timers = vi.spyOn(globalThis, 'setTimeout')
      await expect(
        downloadImage({ from: 'bytes', base64: 'QUJD', mime: 'image/jpeg' }, 'Image')
      ).resolves.toBe('saved')

      expect(clicked).toEqual([{ href: 'blob:termul/download', download: 'Image.jpg' }])
      expect(await blobBytes(created[0])).toEqual([65, 66, 67])
      expect(created[0].type).toBe('image/jpeg')
      expect(mutableURL.revokeObjectURL).not.toHaveBeenCalled()
      const revoke = timers.mock.calls.find(([, delay]) => delay === 30_000)?.[0]
      ;(revoke as () => void)()
      expect(mutableURL.revokeObjectURL).toHaveBeenCalledWith('blob:termul/download')
      expect(document.querySelector('a[download]')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('decodes a data: URL in place instead of fetching it', async () => {
      await downloadImage({ from: 'url', url: 'data:image/webp;base64,QUJD' }, 'chart')

      expect(clicked).toEqual([{ href: 'blob:termul/download', download: 'chart.webp' }])
      expect(await blobBytes(created[0])).toEqual([65, 66, 67])
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reads a local path through readMediaBytes', async () => {
      readMediaBytesMock.mockResolvedValue({
        success: true,
        data: new Blob([ABC], { type: 'image/png' })
      })

      await downloadImage({ from: 'path', path: '/proj/out/shot.png' }, 'shot.png')

      expect(readMediaBytesMock).toHaveBeenCalledWith('/proj/out/shot.png')
      expect(clicked).toEqual([{ href: 'blob:termul/download', download: 'shot.png' }])
    })

    it('fetches a remote URL and saves it under its blob type', async () => {
      fetchMock.mockResolvedValue(new Response(ABC, { headers: { 'content-type': 'image/gif' } }))

      await expect(
        downloadImage({ from: 'url', url: 'https://x.test/render?id=3' }, 'render')
      ).resolves.toBe('saved')

      expect(fetchMock).toHaveBeenCalledWith('https://x.test/render?id=3')
      expect(clicked).toEqual([{ href: 'blob:termul/download', download: 'render.gif' }])
      expect(requestExternalLinkOpenMock).not.toHaveBeenCalled()
    })

    it('opens a remote URL externally when the fetch fails on CORS', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

      await expect(
        downloadImage({ from: 'url', url: 'https://x.test/a.png' }, 'a.png')
      ).resolves.toBe('opened-externally')

      expect(requestExternalLinkOpenMock).toHaveBeenCalledWith('https://x.test/a.png')
      expect(clicked).toEqual([])
    })

    it('throws when the external open cannot be requested', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
      requestExternalLinkOpenMock.mockReturnValue(false)

      await expect(
        downloadImage({ from: 'url', url: 'https://x.test/a.png' }, 'a.png')
      ).rejects.toThrow('Could not open the image link')
    })

    it('throws when a local read fails', async () => {
      readMediaBytesMock.mockResolvedValue({
        success: false,
        error: 'not found',
        code: 'NOT_FOUND'
      })

      await expect(downloadImage({ from: 'path', path: '/gone.png' }, 'gone.png')).rejects.toThrow(
        'NOT_FOUND: not found'
      )
      expect(clicked).toEqual([])
    })
  })

  describe('desktop', () => {
    beforeEach(() => isTauriContextMock.mockReturnValue(true))

    it('asks for a location and writes the source bytes there', async () => {
      saveFileMock.mockResolvedValue({ success: true, data: '/home/u/Pictures/chart.png' })

      await expect(
        downloadImage({ from: 'bytes', base64: 'QUJD', mime: 'image/png' }, 'chart.png')
      ).resolves.toBe('saved')

      expect(saveFileMock).toHaveBeenCalledWith({ title: 'Save image', defaultPath: 'chart.png' })
      expect(writeFileMock).toHaveBeenCalledWith('/home/u/Pictures/chart.png', ABC)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(clicked).toEqual([])
    })

    it('reads a path through readMediaBytes, never fetch', async () => {
      readMediaBytesMock.mockResolvedValue({
        success: true,
        data: new Blob([ABC], { type: 'image/png' })
      })
      saveFileMock.mockResolvedValue({ success: true, data: '/home/u/shot.png' })

      await downloadImage({ from: 'path', path: '/proj/shot.png' }, 'shot.png')

      expect(writeFileMock).toHaveBeenCalledWith('/home/u/shot.png', ABC)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
      'https://x.test/a.png',
      'blob:termul/1'
    ])('opens %s externally without fetching it', async (url) => {
      await expect(downloadImage({ from: 'url', url }, 'a.png')).resolves.toBe('opened-externally')

      expect(requestExternalLinkOpenMock).toHaveBeenCalledWith(url)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(saveFileMock).not.toHaveBeenCalled()
    })

    it('does nothing when the save dialog is cancelled', async () => {
      saveFileMock.mockResolvedValue({
        success: false,
        error: 'No location selected',
        code: 'CANCELLED'
      })

      await expect(
        downloadImage({ from: 'bytes', base64: 'QUJD', mime: 'image/png' }, 'a.png')
      ).resolves.toBe('cancelled')
      expect(writeFileMock).not.toHaveBeenCalled()
    })

    it('throws when the save dialog fails', async () => {
      saveFileMock.mockResolvedValue({
        success: false,
        error: 'dialog broke',
        code: 'DIALOG_ERROR'
      })

      await expect(
        downloadImage({ from: 'bytes', base64: 'QUJD', mime: 'image/png' }, 'a.png')
      ).rejects.toThrow('dialog broke')
      expect(writeFileMock).not.toHaveBeenCalled()
    })

    it('throws when the write fails', async () => {
      saveFileMock.mockResolvedValue({ success: true, data: '/root/a.png' })
      writeFileMock.mockRejectedValueOnce(new Error('forbidden path'))

      await expect(
        downloadImage({ from: 'bytes', base64: 'QUJD', mime: 'image/png' }, 'a.png')
      ).rejects.toThrow('forbidden path')
    })
  })
})

describe('imageFileName', () => {
  it.each([
    ['chart.webp', '', 'chart.webp'],
    ['Image', 'image/jpeg', 'Image.jpg'],
    ['diagram', 'image/svg+xml', 'diagram.svg'],
    ['report.pdf', 'image/png', 'report.pdf.png'],
    ['plot', '', 'plot.png'],
    ['', '', 'image.png'],
    ['a/b: c', '', 'a_b_ c.png'],
    ['shot\u0007\u007f.png', '', 'shot.png'],
    ['name. . ', 'image/gif', 'name.gif']
  ])('%j with %j becomes %j', (name, mime, expected) => {
    expect(imageFileName(name, mime)).toBe(expected)
  })
})
