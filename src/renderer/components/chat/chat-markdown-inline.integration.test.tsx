import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type Components, defaultRemarkPlugins, Streamdown } from 'streamdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, fetchMock, logFrontendErrorMock, isTauriContextMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  fetchMock: vi.fn(),
  logFrontendErrorMock: vi.fn(() => Promise.resolve()),
  isTauriContextMock: vi.fn(() => false)
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: (...args: unknown[]) => logFrontendErrorMock(...args)
}))

vi.mock('@/lib/tauri-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri-runtime')>()
  return { ...actual, isTauriContext: () => isTauriContextMock() }
})

import { TermulFilePathButton, TermulMarkdownMedia } from './ChatMessage'
import { STREAMDOWN_ALLOWED_TAGS } from './chat-agent-prose'
import { remarkFilePathLinks } from './chat-markdown-file-links'
import { remarkTermulMedia } from './chat-markdown-images'

const REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkTermulMedia,
  remarkFilePathLinks
]

/** Mirrors the AgentProse wiring in ChatMessage.tsx with real Streamdown. */
function chatElement(text: string, cwd?: string): React.JSX.Element {
  const components: Components = {
    'termul-media': (props: Record<string, unknown>) => (
      <TermulMarkdownMedia
        url={typeof props['data-url'] === 'string' ? props['data-url'] : ''}
        alt={typeof props['data-alt'] === 'string' ? props['data-alt'] : ''}
        linkPreview={props['data-link-preview'] === 'true'}
        filePathContext={{ cwd }}
      />
    ),
    'termul-file-path': (props: Record<string, unknown>) => {
      const path = typeof props['data-path'] === 'string' ? props['data-path'] : ''
      return (
        <TermulFilePathButton path={path} context={{ cwd }}>
          {props.children as React.ReactNode}
        </TermulFilePathButton>
      )
    }
  }
  return (
    <Streamdown
      mode="static"
      remarkPlugins={REMARK_PLUGINS}
      allowedTags={STREAMDOWN_ALLOWED_TAGS}
      components={components}
      controls={false}
      lineNumbers={false}
      linkSafety={{ enabled: false }}
    >
      {text}
    </Streamdown>
  )
}

function renderChat(text: string, cwd?: string): ReturnType<typeof render> {
  return render(chatElement(text, cwd))
}

const ABC = new Uint8Array([65, 66, 67])
const mutableURL = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }

function desktopReadFails(code: string): void {
  invokeMock.mockRejectedValueOnce({ code, message: code.toLowerCase() })
}

describe('chat inline termul tags with real Streamdown', () => {
  const createObjectURL = vi.fn()
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    invokeMock.mockReset()
    fetchMock.mockReset()
    logFrontendErrorMock.mockClear()
    isTauriContextMock.mockReturnValue(false)
    let next = 0
    createObjectURL.mockReset().mockImplementation(() => `blob:termul/${++next}`)
    revokeObjectURL.mockReset()
    mutableURL.createObjectURL = createObjectURL
    mutableURL.revokeObjectURL = revokeObjectURL
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete mutableURL.createObjectURL
    delete mutableURL.revokeObjectURL
  })

  it('renders a prose file path as the open-in-editor button with no [blocked]', async () => {
    const { container } = renderChat('See src/App.tsx:42.')

    await waitFor(() => {
      const button = container.querySelector<HTMLElement>('button[data-path="src/App.tsx:42"]')
      expect(button).not.toBeNull()
      expect(button).toHaveTextContent('src/App.tsx:42')
      expect(button).toHaveAttribute('title', 'Open in editor')
    })
    expect(container.textContent).not.toContain('[blocked]')
  })

  it.each([
    ['[DESIGN.md](file:///C:/p/DESIGN.md)', 'C:/p/DESIGN.md', 'DESIGN.md'],
    ['[x](file:///home/u/a.ts)', '/home/u/a.ts', 'x'],
    ['[DESIGN.md](DESIGN.md)', 'DESIGN.md', 'DESIGN.md'],
    ['[x](/abs/path/file.md)', '/abs/path/file.md', 'x'],
    ['[spec](file:///C:/my%20proj/a.md#L12)', 'C:/my proj/a.md:12', 'spec']
  ])('renders markdown link %s as an open-in-editor button', async (markdown, path, label) => {
    const { container } = renderChat(markdown)

    await waitFor(() => {
      const button = container.querySelector<HTMLElement>('button[data-testid="termul-file-path"]')
      expect(button).not.toBeNull()
      expect(button).toHaveAttribute('data-path', path)
      expect(button).toHaveTextContent(label)
    })
    expect(container.textContent).not.toContain('[blocked]')
  })

  it('keeps https links as anchors, not file buttons', async () => {
    const { container } = renderChat('[x](https://example.com/a.md)')

    await waitFor(() => {
      expect(container.querySelector('a, button[data-streamdown="link"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-testid="termul-file-path"]')).toBeNull()
  })

  it.each([
    '[x](#sec)',
    '[x](mailto:a@b.c)',
    '[x](file:///%zz)',
    '[x](file://server/share/a.md)'
  ])('does not rewrite %s into a file button', async (markdown) => {
    const { container } = renderChat(markdown)

    await waitFor(() => {
      expect(container.textContent).toContain('x')
    })
    expect(container.querySelector('[data-testid="termul-file-path"]')).toBeNull()
  })

  it('renders data: images inline with no [Image blocked', async () => {
    const { container } = renderChat('![tiny](data:image/png;base64,QUJD)')

    await waitFor(() => {
      const img = screen.getByAltText('tiny')
      expect(img).toHaveAttribute('src', 'data:image/png;base64,QUJD')
    })
    expect(container.textContent).not.toContain('[Image blocked')
  })

  it('renders reference-style data: images inline with no [Image blocked', async () => {
    const { container } = renderChat(
      '![tiny][Ref] and ![chart]\n\n[ref]: data:image/png;base64,QUJD\n[chart]: output/chart.png',
      '/proj'
    )

    await waitFor(() => {
      expect(screen.getByAltText('tiny')).toHaveAttribute('src', 'data:image/png;base64,QUJD')
      expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('chart')
    })
    expect(container.textContent).not.toContain('[Image blocked')
  })

  it('renders reference-style https images through the lightbox', async () => {
    renderChat('![logo][l]\n\n[l]: https://example.com/logo.png')

    const img = await waitFor(() => screen.getByAltText('logo'))
    expect(img).toHaveAttribute('src', 'https://example.com/logo.png')
    expect(screen.getByRole('button', { name: 'Open image: logo' })).toContainElement(img)
  })

  it('opens a markdown image in the lightbox on click', async () => {
    renderChat('![logo](https://example.com/logo.png)')

    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Open image: logo' })))

    const dialog = await waitFor(() => screen.getByRole('dialog'))
    expect(dialog.querySelector('img')).toHaveAttribute('src', 'https://example.com/logo.png')
  })

  it('renders an https video with the remote src and no preload', async () => {
    const { container } = renderChat('![demo](https://cdn.example.com/demo.mp4)')

    await waitFor(() => {
      expect(container.querySelector('video')).not.toBeNull()
    })
    const video = container.querySelector('video')
    expect(video).toHaveAttribute('src', 'https://cdn.example.com/demo.mp4')
    expect(video).toHaveAttribute('preload', 'none')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still blocks javascript: links', async () => {
    const { container } = renderChat('[x](javascript:alert(1))')

    await waitFor(() => {
      expect(container.textContent).toContain('[blocked]')
    })
  })

  it('renders a relative image on web from /fs/raw as a blob: URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(ABC, { headers: { 'content-type': 'image/png' } }))
    renderChat('![chart](output/chart.png)', '/proj')

    const img = await waitFor(() => screen.getByAltText('chart'))
    expect(img).toHaveAttribute('src', 'blob:termul/1')
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/fs/raw?path=%2Fproj%2Foutput%2Fchart.png`
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('renders a file:// image on web from /fs/raw', async () => {
    fetchMock.mockResolvedValueOnce(new Response(ABC, { headers: { 'content-type': 'image/png' } }))
    renderChat('![shot](file:///tmp/shot%201.png)')

    const img = await waitFor(() => screen.getByAltText('shot'))
    expect(img).toHaveAttribute('src', 'blob:termul/1')
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/fs/raw?path=%2Ftmp%2Fshot%201.png`
    )
  })

  it('resolves relative images against the cwd via read_media_bytes on Tauri', async () => {
    isTauriContextMock.mockReturnValue(true)
    invokeMock.mockResolvedValueOnce(ABC.buffer)
    renderChat('![chart](output/chart.png)', '/proj')

    const img = await waitFor(() => screen.getByAltText('chart'))
    expect(img).toHaveAttribute('src', 'blob:termul/1')
    expect(invokeMock).toHaveBeenCalledWith('read_media_bytes', {
      path: '/proj/output/chart.png'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not read a markdown image that points at a text file', async () => {
    const { container } = renderChat('![notes](out/notes.txt)', '/proj')

    await waitFor(() => {
      expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('notes')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads a local markdown video only after the play click, then plays its blob: URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(ABC, { headers: { 'content-type': 'video/mp4' } }))
    const { container } = renderChat('![clip](out/clip.mp4)', '/proj')

    const play = await waitFor(() => screen.getByRole('button', { name: 'Play video: clip' }))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(play)

    await waitFor(() => {
      expect(container.querySelector('video')).toHaveAttribute('src', 'blob:termul/1')
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/fs/raw?path=%2Fproj%2Fout%2Fclip.mp4`
    )
  })

  it('reads a local markdown video through read_media_bytes on Tauri', async () => {
    isTauriContextMock.mockReturnValue(true)
    invokeMock.mockResolvedValueOnce(ABC.buffer)
    const { container } = renderChat('![rec](file:///tmp/rec.webm)')

    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Play video: rec' })))

    await waitFor(() => {
      expect(container.querySelector('video')).toHaveAttribute('src', 'blob:termul/1')
    })
    expect(invokeMock).toHaveBeenCalledWith('read_media_bytes', { path: '/tmp/rec.webm' })
  })

  it('renders a link to a local image inline with its open-in-editor button', async () => {
    fetchMock.mockResolvedValueOnce(new Response(ABC, { headers: { 'content-type': 'image/png' } }))
    renderChat('See [the shot](out/shot.png).', '/proj')

    const img = await waitFor(() => screen.getByAltText('the shot'))
    expect(img).toHaveAttribute('src', 'blob:termul/1')
    const open = screen.getByTestId('termul-file-path')
    expect(open).toHaveAttribute('data-path', 'out/shot.png')
    expect(open).toHaveTextContent('the shot')
  })

  it('renders nothing for a media link preview that cannot resolve', async () => {
    renderChat('See [clip](clip.mp4) here.')

    await waitFor(() => expect(screen.getByText(/See/)).toBeInTheDocument())
    expect(screen.queryByTestId('chat-media-alt')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Play video: clip' })).toBeNull()
  })

  it('renders a link to a local video as a player with its open-in-editor button', async () => {
    renderChat('[demo](clip.mp4)', '/proj')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Play video: demo' })).toBeInTheDocument()
    })
    expect(screen.getByTestId('termul-file-path')).toHaveAttribute('data-path', 'clip.mp4')
  })

  it('keeps a link to a non-media file as only the open-in-editor button', async () => {
    const { container } = renderChat('[notes](out/notes.md)', '/proj')

    await waitFor(() => {
      expect(screen.getByTestId('termul-file-path')).toHaveAttribute('data-path', 'out/notes.md')
    })
    expect(container.querySelector('img, video')).toBeNull()
  })

  it('keeps a bare media path in prose as a file button, not inline media', async () => {
    const { container } = renderChat('Saved to out/shot.png today.', '/proj')

    await waitFor(() => {
      expect(screen.getByTestId('termul-file-path')).toHaveAttribute('data-path', 'out/shot.png')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the alt-text chip and logs when the local read fails', async () => {
    isTauriContextMock.mockReturnValue(true)
    desktopReadFails('UNSUPPORTED_MEDIA')
    const { container } = renderChat('![chart](output/chart.png)', '/proj')

    await waitFor(() => {
      expect(logFrontendErrorMock).toHaveBeenCalledWith({
        level: 'warn',
        source: 'mediaBytes.read',
        message: "Failed to read media 'chart.png' (UNSUPPORTED_MEDIA)"
      })
    })
    expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('chart')
    expect(container.querySelector('img')).toBeNull()
  })

  it('revokes the blob URL and shows the chip when the image URL changes', async () => {
    isTauriContextMock.mockReturnValue(true)
    invokeMock.mockResolvedValueOnce(ABC.buffer)
    const { rerender, container } = render(chatElement('![chart](output/chart.png)', '/proj'))

    await waitFor(() => {
      expect(screen.getByAltText('chart')).toHaveAttribute('src', 'blob:termul/1')
    })

    desktopReadFails('NOT_FOUND')
    rerender(chatElement('![other](missing/other.png)', '/proj'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('other')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:termul/1')
  })

  it('clears the resolved preview when the cwd changes and the re-read fails', async () => {
    isTauriContextMock.mockReturnValue(true)
    invokeMock.mockResolvedValueOnce(ABC.buffer)
    const { rerender, container } = render(
      <TermulMarkdownMedia url="output/chart.png" alt="chart" filePathContext={{ cwd: '/proj' }} />
    )

    await waitFor(() => {
      expect(screen.getByAltText('chart')).toHaveAttribute('src', 'blob:termul/1')
    })

    desktopReadFails('NOT_FOUND')
    rerender(
      <TermulMarkdownMedia url="output/chart.png" alt="chart" filePathContext={{ cwd: '/other' }} />
    )

    await waitFor(() => {
      expect(invokeMock).toHaveBeenLastCalledWith('read_media_bytes', {
        path: '/other/output/chart.png'
      })
    })
    expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('chart')
    expect(container.querySelector('img')).toBeNull()
  })

  it('revokes the blob URL on unmount', async () => {
    invokeMock.mockResolvedValueOnce(ABC.buffer)
    isTauriContextMock.mockReturnValue(true)
    const { unmount } = render(<TermulMarkdownMedia url="/abs/chart.png" alt="chart" />)

    await waitFor(() => {
      expect(screen.getByAltText('chart')).toHaveAttribute('src', 'blob:termul/1')
    })
    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:termul/1')
  })

  it('renders the alt chip for malformed file URLs without crashing', async () => {
    isTauriContextMock.mockReturnValue(true)
    const { container } = render(chatElement('![bad](file:///%zz)', '/proj'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('bad')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('falls back to the alt chip when the image fails to decode (onError)', async () => {
    const { container } = render(chatElement('![tiny](data:image/png;base64,not-base64)'))

    const img = await waitFor(() => screen.getByAltText('tiny'))
    fireEvent.error(img)

    await waitFor(() => {
      expect(screen.getByTestId('chat-media-alt')).toHaveTextContent('tiny')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(logFrontendErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'ChatMedia.image' })
    )
  })
})
