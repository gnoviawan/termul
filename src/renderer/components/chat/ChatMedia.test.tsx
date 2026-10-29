import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@/lib/acp-api'

const { invokeMock, fetchMock, isTauriContextMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  fetchMock: vi.fn(),
  isTauriContextMock: vi.fn(() => false)
}))

// The real readMediaBytes facade runs; only its two transports are faked.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

vi.mock('@/lib/tauri-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri-runtime')>()
  return { ...actual, isTauriContext: () => isTauriContextMock() }
})

import { ChatMedia } from './ChatMedia'
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
      message: 'file too large (134217728 bytes, max 104857600)'
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
})
