import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type Components, defaultRemarkPlugins, Streamdown } from 'streamdown'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readAttachmentBytesMock, logFrontendErrorMock, isTauriContextMock } = vi.hoisted(() => ({
  readAttachmentBytesMock: vi.fn(),
  logFrontendErrorMock: vi.fn(() => Promise.resolve()),
  isTauriContextMock: vi.fn(() => false)
}))

vi.mock('@/lib/attachment-api', () => ({
  readAttachmentBytes: (...args: unknown[]) => readAttachmentBytesMock(...args)
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: (...args: unknown[]) => logFrontendErrorMock(...args)
}))

vi.mock('@/lib/tauri-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri-runtime')>()
  return { ...actual, isTauriContext: () => isTauriContextMock() }
})

import { TermulFilePathButton, TermulMarkdownImage } from './ChatMessage'
import { remarkFilePathLinks } from './chat-markdown-file-links'
import { remarkTermulImages } from './chat-markdown-images'

const REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkTermulImages,
  remarkFilePathLinks
]

const ALLOWED_TAGS = {
  'termul-file-path': ['dataPath'],
  'termul-image': ['dataUrl', 'dataAlt']
}

/** Mirrors the AgentProse wiring in ChatMessage.tsx with real Streamdown. */
function chatElement(text: string, cwd?: string): React.JSX.Element {
  const components: Components = {
    'termul-image': (props: Record<string, unknown>) => (
      <TermulMarkdownImage
        url={typeof props['data-url'] === 'string' ? props['data-url'] : ''}
        alt={typeof props['data-alt'] === 'string' ? props['data-alt'] : ''}
        cwd={cwd}
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
      allowedTags={ALLOWED_TAGS}
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

describe('chat inline termul tags with real Streamdown', () => {
  beforeEach(() => {
    readAttachmentBytesMock.mockReset()
    logFrontendErrorMock.mockClear()
    isTauriContextMock.mockReturnValue(false)
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

  it('renders data: images inline with no [Image blocked', async () => {
    const { container } = renderChat('![tiny](data:image/png;base64,QUJD)')

    await waitFor(() => {
      const img = screen.getByAltText('tiny')
      expect(img).toHaveAttribute('src', 'data:image/png;base64,QUJD')
    })
    expect(container.textContent).not.toContain('[Image blocked')
  })

  it('keeps https images on the streamdown default image wrapper', async () => {
    const { container } = renderChat('![logo](https://example.com/logo.png)')

    await waitFor(() => {
      const wrapper = container.querySelector('[data-streamdown="image"]')
      expect(wrapper).not.toBeNull()
      expect(container.querySelector('img')).not.toBeNull()
    })
  })

  it('still blocks javascript: links', async () => {
    const { container } = renderChat('[x](javascript:alert(1))')

    await waitFor(() => {
      expect(container.textContent).toContain('[blocked]')
    })
  })

  it('renders a muted alt-text chip for relative images on web (no Tauri)', async () => {
    const { container } = renderChat('![chart](output/chart.png)', '/proj')

    await waitFor(() => {
      expect(screen.getByTestId('termul-image-alt')).toHaveTextContent('chart')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(readAttachmentBytesMock).not.toHaveBeenCalled()
  })

  it('resolves relative images against the cwd via readAttachmentBytes on Tauri', async () => {
    isTauriContextMock.mockReturnValue(true)
    readAttachmentBytesMock.mockResolvedValueOnce(new Uint8Array([65, 66, 67]))
    renderChat('![chart](output/chart.png)', '/proj')

    await waitFor(() => {
      expect(readAttachmentBytesMock).toHaveBeenCalledWith('/proj/output/chart.png')
    })
    const img = await waitFor(() => screen.getByAltText('chart'))
    expect(img).toHaveAttribute('src', 'data:image/png;base64,QUJD')
  })

  it('falls back to the alt-text chip and warns when the local read fails', async () => {
    isTauriContextMock.mockReturnValue(true)
    readAttachmentBytesMock.mockRejectedValueOnce(new Error('not an image'))
    const { container } = renderChat('![chart](output/chart.png)', '/proj')

    await waitFor(() => {
      expect(screen.getByTestId('termul-image-alt')).toHaveTextContent('chart')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(logFrontendErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'ChatMessage.termulImage' })
    )
  })

  it('clears the resolved preview when the image URL changes', async () => {
    isTauriContextMock.mockReturnValue(true)
    readAttachmentBytesMock.mockResolvedValueOnce(new Uint8Array([65, 66, 67]))
    const { rerender, container } = render(chatElement('![chart](output/chart.png)', '/proj'))

    await waitFor(() => {
      expect(screen.getByAltText('chart')).toHaveAttribute('src', 'data:image/png;base64,QUJD')
    })

    readAttachmentBytesMock.mockRejectedValueOnce(new Error('gone'))
    rerender(chatElement('![other](missing/other.png)', '/proj'))

    await waitFor(() => {
      expect(screen.getByTestId('termul-image-alt')).toHaveTextContent('other')
    })
    expect(container.querySelector('img')).toBeNull()
  })

  it('clears the resolved preview when the cwd changes and the re-read fails', async () => {
    isTauriContextMock.mockReturnValue(true)
    readAttachmentBytesMock.mockResolvedValueOnce(new Uint8Array([65, 66, 67]))
    const { rerender, container } = render(
      <TermulMarkdownImage url="output/chart.png" alt="chart" cwd="/proj" />
    )

    await waitFor(() => {
      expect(screen.getByAltText('chart')).toHaveAttribute('src', 'data:image/png;base64,QUJD')
    })

    readAttachmentBytesMock.mockRejectedValueOnce(new Error('not under new root'))
    rerender(<TermulMarkdownImage url="output/chart.png" alt="chart" cwd="/other" />)

    await waitFor(() => {
      expect(readAttachmentBytesMock).toHaveBeenCalledWith('/other/output/chart.png')
    })
    await waitFor(() => {
      expect(screen.getByTestId('termul-image-alt')).toBeInTheDocument()
    })
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders the alt chip for malformed file URLs without crashing', async () => {
    isTauriContextMock.mockReturnValue(true)
    const { container } = render(chatElement('![bad](file:///%zz)', '/proj'))

    await waitFor(() => {
      expect(screen.getByTestId('termul-image-alt')).toHaveTextContent('bad')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(readAttachmentBytesMock).not.toHaveBeenCalled()
  })

  it('falls back to the alt chip when the image fails to decode (onError)', async () => {
    const { container } = render(chatElement('![tiny](data:image/png;base64,not-base64)'))

    const img = await waitFor(() => screen.getByAltText('tiny'))
    fireEvent.error(img)

    await waitFor(() => {
      expect(screen.getByTestId('termul-image-alt')).toHaveTextContent('tiny')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(logFrontendErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'ChatMessage.termulImage' })
    )
  })
})
