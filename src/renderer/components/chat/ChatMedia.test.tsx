import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@/lib/acp-api'

const { invokeMock, fetchMock, isTauriContextMock, downloadImageMock, toastErrorMock } = vi.hoisted(
  () => ({
    invokeMock: vi.fn(),
    fetchMock: vi.fn(),
    isTauriContextMock: vi.fn(() => false),
    downloadImageMock: vi.fn(() => Promise.resolve('saved')),
    toastErrorMock: vi.fn()
  })
)

vi.mock('@/lib/image-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/image-download')>()),
  downloadImage: (...args: unknown[]) => downloadImageMock(...args)
}))

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastErrorMock(...args) } }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

vi.mock('@/lib/tauri-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri-runtime')>()
  return { ...actual, isTauriContext: () => isTauriContextMock() }
})

import { ChatImageGallery, ChatMedia, mediaFileName } from './ChatMedia'
import { MediaBlocks } from './ChatMessage'

const ABC = new Uint8Array([65, 66, 67])
const mutableURL = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }
const created: Blob[] = []

function renderBlocks(...blocks: ContentBlock[]): ReturnType<typeof render> {
  return render(<MediaBlocks blocks={blocks} />)
}

describe('MediaBlocks inline media', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    fetchMock.mockReset()
    isTauriContextMock.mockReturnValue(false)
    created.length = 0
    mutableURL.createObjectURL = (blob: Blob) => {
      created.push(blob)
      return `blob:termul/${created.length}`
    }
    mutableURL.revokeObjectURL = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete mutableURL.createObjectURL
    delete mutableURL.revokeObjectURL
  })

  it('renders a uri-only image block from its uri in a lightbox tile', () => {
    renderBlocks({
      type: 'image',
      data: '',
      mimeType: 'image/png',
      uri: 'https://example.com/chart.png'
    })

    const img = screen.getByAltText('chart.png')
    expect(img).toHaveAttribute('src', 'https://example.com/chart.png')
    expect(screen.getByRole('button', { name: 'Open image: chart.png' })).toContainElement(img)
  })

  it('renders a base64 image block from a blob: URL', async () => {
    renderBlocks({ type: 'image', data: 'QUJD', mimeType: 'image/png' })

    await waitFor(() => {
      expect(screen.getByAltText('Image')).toHaveAttribute('src', 'blob:termul/1')
    })
    expect(created.map((blob) => [blob.type, blob.size])).toEqual([['image/png', 3]])
  })

  it('plays a base64 video resource from a blob: URL, never a data: URL', async () => {
    const { container } = renderBlocks({
      type: 'resource',
      resource: { uri: 'file:///tmp/rec.webm', mimeType: 'video/webm', blob: 'QUJD' }
    })

    await waitFor(() => {
      expect(container.querySelector('video')).toHaveAttribute('src', 'blob:termul/1')
    })
    expect(container.querySelector('video')).toHaveAttribute('preload', 'metadata')
    expect(created.map((blob) => [blob.type, blob.size])).toEqual([['video/webm', 3]])
  })

  it('plays a resource_link to an https video with the remote src and no preload', () => {
    const { container } = renderBlocks({
      type: 'resource_link',
      uri: 'https://cdn.example.com/demo.mp4',
      name: 'demo.mp4'
    })

    const video = container.querySelector('video')
    expect(video).toHaveAttribute('src', 'https://cdn.example.com/demo.mp4')
    expect(video).toHaveAttribute('preload', 'none')
    expect(video).toHaveAttribute('aria-label', 'demo.mp4')
  })

  it('reads a local video resource_link on desktop only after the play click', async () => {
    isTauriContextMock.mockReturnValue(true)
    invokeMock.mockResolvedValueOnce(ABC.buffer)
    const { container } = renderBlocks({
      type: 'resource_link',
      uri: 'file:///tmp/demo.mp4',
      name: 'demo.mp4'
    })

    const play = screen.getByRole('button', { name: 'Play video: demo.mp4' })
    expect(invokeMock).not.toHaveBeenCalled()
    fireEvent.click(play)

    await waitFor(() => {
      expect(container.querySelector('video')).toHaveAttribute('src', 'blob:termul/1')
    })
    expect(invokeMock).toHaveBeenCalledWith('read_media_bytes', { path: '/tmp/demo.mp4' })
    expect(created.map((blob) => blob.type)).toEqual(['video/mp4'])
  })

  it('says a local video is too large instead of loading forever', async () => {
    isTauriContextMock.mockReturnValue(true)
    invokeMock.mockRejectedValueOnce({
      code: 'FILE_TOO_LARGE',
      message: 'file too large',
      size: 134217728,
      limit: 104857600
    })
    const { container } = renderBlocks({
      type: 'resource_link',
      uri: 'file:///tmp/clip.mp4',
      name: 'clip.mp4'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Play video: clip.mp4' }))

    expect(
      await screen.findByText('clip.mp4 is too large to play inline (128.0 MB, limit 100.0 MB)')
    ).toBeInTheDocument()
    expect(screen.queryByText('Loading video')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('video')).toBeNull()
  })

  it('says a local video was not found instead of loading forever', async () => {
    isTauriContextMock.mockReturnValue(true)
    invokeMock.mockRejectedValueOnce({ code: 'NOT_FOUND', message: 'file not found' })
    renderBlocks({ type: 'resource_link', uri: 'file:///tmp/clip.mp4', name: 'clip.mp4' })

    fireEvent.click(screen.getByRole('button', { name: 'Play video: clip.mp4' }))

    expect(await screen.findByText('clip.mp4 was not found')).toBeInTheDocument()
    expect(screen.queryByText('Loading video')).toBeNull()
  })

  it('reads a local video resource_link on web from /fs/raw after the play click', async () => {
    fetchMock.mockResolvedValueOnce(new Response(ABC, { headers: { 'content-type': 'video/mp4' } }))
    const { container } = renderBlocks({
      type: 'resource_link',
      uri: 'file:///tmp/demo.mp4',
      name: 'demo.mp4'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Play video: demo.mp4' }))

    await waitFor(() => {
      expect(container.querySelector('video')).toHaveAttribute('src', 'blob:termul/1')
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/fs/raw?path=%2Ftmp%2Fdemo.mp4`
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('reads a local image resource_link on web from /fs/raw', async () => {
    fetchMock.mockResolvedValueOnce(new Response(ABC, { headers: { 'content-type': 'image/png' } }))
    renderBlocks({ type: 'resource_link', uri: 'file:///tmp/shot.png', name: 'shot.png' })

    await waitFor(() => {
      expect(screen.getByAltText('shot.png')).toHaveAttribute('src', 'blob:termul/1')
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/fs/raw?path=%2Ftmp%2Fshot.png`
    )
  })

  it('shows the file card while a local image is unreadable', async () => {
    isTauriContextMock.mockReturnValue(true)
    invokeMock.mockRejectedValueOnce({ code: 'NOT_FOUND', message: 'not found' })
    const { container } = renderBlocks({
      type: 'resource_link',
      uri: 'file:///tmp/gone.png',
      name: 'gone.png'
    })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('read_media_bytes', { path: '/tmp/gone.png' })
    })
    expect(screen.getByTitle('gone.png')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  it('gives a local image alt chip the read failure as its tooltip', async () => {
    isTauriContextMock.mockReturnValue(true)
    invokeMock.mockRejectedValueOnce({ code: 'READ_ERROR', message: 'failed to read file' })
    render(
      <ChatMedia
        media={{ kind: 'image', name: 'shot.png', src: { from: 'path', path: '/tmp/shot.png' } }}
      />
    )

    expect(screen.getByTestId('chat-media-alt')).toHaveAttribute('title', 'shot.png')
    await waitFor(() => {
      expect(screen.getByTestId('chat-media-alt')).toHaveAttribute(
        'title',
        "shot.png couldn't be read"
      )
    })
    expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('shot.png')
  })

  it('plays base64 audio from a blob: URL', async () => {
    const { container } = renderBlocks({ type: 'audio', data: 'QUJD', mimeType: 'audio/wav' })

    await waitFor(() => {
      expect(container.querySelector('audio')).toHaveAttribute('src', 'blob:termul/1')
    })
    expect(container.querySelector('audio')).toHaveAttribute('aria-label', 'Play audio')
  })

  it('keeps a non-media file as a card with no media element', () => {
    const { container } = renderBlocks({
      type: 'resource_link',
      uri: 'file:///tmp/notes.md',
      name: 'notes.md'
    })

    expect(screen.getByTitle('notes.md')).toBeInTheDocument()
    expect(container.querySelector('img, video, audio')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says inline audio and video that fail to decode could not be read', async () => {
    render(
      <>
        <ChatMedia
          media={{
            kind: 'audio',
            name: 'voice.wav',
            src: { from: 'bytes', base64: '%%%', mime: 'audio/wav' }
          }}
        />
        <ChatMedia
          media={{
            kind: 'video',
            name: 'clip.webm',
            src: { from: 'bytes', base64: '%%%', mime: 'video/webm' }
          }}
        />
      </>
    )
    expect(await screen.findByText("voice.wav couldn't be read")).toBeInTheDocument()
    expect(await screen.findByText("clip.webm couldn't be read")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play video: clip.webm' })).toBeNull()
  })
})

describe('chat image viewer', () => {
  beforeEach(() => {
    downloadImageMock.mockReset()
    downloadImageMock.mockResolvedValue('saved')
    toastErrorMock.mockReset()
  })

  const remote = (name: string): ContentBlock => ({
    type: 'image',
    data: '',
    mimeType: 'image/png',
    uri: `https://example.com/${name}`
  })

  function counter(): string | null {
    return screen.queryByText(/^\d+ of \d+$/)?.textContent ?? null
  }

  it('shares one viewer across the attachment tiles of a message', () => {
    renderBlocks(remote('a.png'), remote('b.png'), remote('c.png'))

    expect(screen.getByAltText('b.png')).toHaveAttribute('width', '96')
    fireEvent.click(screen.getByRole('button', { name: 'Open image: b.png' }))

    expect(counter()).toBe('2 of 3')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('leaves a broken attachment tile out of the viewer and shows its file card', async () => {
    renderBlocks(remote('a.png'), remote('broken.png'), remote('c.png'))

    fireEvent.error(screen.getByAltText('broken.png'))

    await waitFor(() => expect(screen.queryByAltText('broken.png')).toBeNull())
    expect(screen.getByTitle('broken.png')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open image: c.png' }))
    expect(counter()).toBe('2 of 2')
  })

  it('renders a markdown gallery as 112px tiles and leaves a broken one out of the viewer', async () => {
    render(
      <ChatImageGallery
        items={['a', 'b', 'c', 'd'].map((name) => ({
          alt: name,
          media: {
            kind: 'image' as const,
            name,
            src: { from: 'url' as const, url: `https://example.com/${name}.png` }
          }
        }))}
      />
    )
    const strip = screen.getByRole('group', { name: '4 images' })
    expect(strip).toHaveClass('overflow-x-auto')
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('width'))).toEqual([
      '112',
      '112',
      '112',
      '112'
    ])

    fireEvent.error(screen.getByAltText('b'))
    await waitFor(() => expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('b'))
    fireEvent.click(screen.getByRole('button', { name: 'Open image: c' }))

    expect(counter()).toBe('2 of 3')
  })

  it('shows an unresolvable markdown image as an alt tile outside the viewer', () => {
    render(
      <ChatImageGallery
        items={[
          { alt: 'gone', media: null },
          {
            alt: 'kept',
            media: {
              kind: 'image',
              name: 'kept',
              src: { from: 'url', url: 'https://x.test/k.png' }
            }
          }
        ]}
      />
    )

    expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('gone')
    fireEvent.click(screen.getByRole('button', { name: 'Open image: kept' }))
    expect(counter()).toBeNull()
  })

  it('downloads the image on screen and says so when the download fails', async () => {
    downloadImageMock.mockRejectedValueOnce(new Error('disk full'))
    render(
      <ChatMedia
        media={{ kind: 'image', name: 'chart', src: { from: 'url', url: 'https://x.test/c.png' } }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open image: chart' }))
    expect(counter()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Download c.png' }))

    expect(downloadImageMock).toHaveBeenCalledWith(
      { from: 'url', url: 'https://x.test/c.png' },
      'c.png'
    )
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Failed to download image'))
  })

  it('downloads an attachment from its source bytes, not its object URL', () => {
    mutableURL.createObjectURL = () => 'blob:termul/1'
    mutableURL.revokeObjectURL = vi.fn()
    renderBlocks({ type: 'image', data: 'QUJD', mimeType: 'image/png' })

    fireEvent.click(screen.getByRole('button', { name: 'Open image: Image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download Image.png' }))

    expect(downloadImageMock).toHaveBeenCalledWith(
      { from: 'bytes', base64: 'QUJD', mime: 'image/png' },
      'Image.png'
    )
    delete mutableURL.createObjectURL
    delete mutableURL.revokeObjectURL
  })

  it('returns focus to the tile that opened the viewer', async () => {
    renderBlocks(remote('a.png'), remote('b.png'))
    const tile = screen.getByRole('button', { name: 'Open image: b.png' })

    fireEvent.click(tile)
    fireEvent.click(screen.getByRole('button', { name: 'Close image' }))

    await waitFor(() => expect(document.activeElement).toBe(tile))
  })

  it('stays quiet when the save dialog is cancelled', async () => {
    downloadImageMock.mockResolvedValueOnce('cancelled')
    render(
      <ChatMedia
        media={{ kind: 'image', name: 'chart', src: { from: 'url', url: 'https://x.test/c.png' } }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open image: chart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download c.png' }))

    await waitFor(() => expect(downloadImageMock).toHaveBeenCalledTimes(1))
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it.each([
    [{ from: 'path' as const, path: '/tmp/out/chart.webp' }, 'shot', 'chart.webp'],
    [{ from: 'url' as const, url: 'https://x.test/a/my%20plot.jpg?v=2' }, 'plot', 'my plot.jpg'],
    [{ from: 'url' as const, url: 'https://x.test/render?id=3' }, 'diagram', 'diagram.png'],
    [{ from: 'url' as const, url: 'data:image/png;base64,QUJD' }, '', 'image.png'],
    [{ from: 'url' as const, url: 'data:image/jpeg;base64,QUJD' }, 'photo', 'photo.jpg'],
    [{ from: 'bytes' as const, base64: 'QUJD', mime: 'image/webp' }, 'Image', 'Image.webp'],
    [{ from: 'bytes' as const, base64: 'QUJD', mime: 'image/png' }, 'pasted.png', 'pasted.png'],
    [{ from: 'url' as const, url: 'blob:termul/1' }, 'a/b: c', 'a_b_ c.png']
  ])('names the download after the file: %o', (src, name, expected) => {
    expect(mediaFileName({ kind: 'image', name, src })).toBe(expected)
  })
})
