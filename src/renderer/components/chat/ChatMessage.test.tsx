import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { AnimateOptions } from 'streamdown'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { skillToken } from '@/lib/skill-tokens'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { ChatMessage } from './ChatMessage'

const T = skillToken

const openUrlWithSystemBrowser = vi.fn(() => Promise.resolve({ success: true, data: undefined }))
const openFilePathFromTerminal = vi.fn(() => Promise.resolve({ ok: true as const }))

vi.mock('@/lib/api', () => ({
  openerApi: {
    openUrlWithSystemBrowser: (...args: unknown[]) => openUrlWithSystemBrowser(...args)
  }
}))

vi.mock('@/lib/file-path-links', () => ({
  openFilePathFromTerminal: (...args: unknown[]) => openFilePathFromTerminal(...args)
}))

vi.mock('streamdown', async () => {
  const React = await import('react')
  type LinkSafety = {
    enabled: boolean
    onLinkCheck?: (url: string) => boolean | Promise<boolean>
    renderModal?: (props: {
      isOpen: boolean
      onClose: () => void
      onConfirm: () => void
      url: string
    }) => ReactNode
  }

  function MockStreamdown({
    children,
    isAnimating,
    caret,
    animated,
    linkSafety,
    components,
    plugins
  }: {
    children: ReactNode
    isAnimating?: boolean
    caret?: string
    animated?: boolean | AnimateOptions
    linkSafety?: LinkSafety
    components?: Record<string, unknown>
    plugins?: { renderers?: { language: string | string[] }[] } & Record<string, unknown>
  }): React.JSX.Element {
    const [open, setOpen] = React.useState(false)
    const url = 'https://example.com/docs'
    const markdown = typeof children === 'string' ? children : ''
    const CustomTable = components?.table as React.ElementType | undefined
    const CustomLink = components?.a as React.ElementType | undefined
    const semanticFixture = markdown.startsWith('# Compact heading')
    const animatedConfig = animated === false || animated === true ? undefined : animated
    const animatedName =
      animated === false ? 'false' : animated === true ? 'true' : (animatedConfig?.animation ?? '')
    const animatedDuration = animatedConfig ? String(animatedConfig.duration ?? '') : ''
    const animatedStagger = animatedConfig ? String(animatedConfig.stagger ?? '') : ''
    const animatedEasing = animatedConfig?.easing ?? ''
    const rendererLanguages = (plugins?.renderers ?? [])
      .flatMap((r) => (Array.isArray(r.language) ? r.language : [r.language]))
      .join(',')

    return (
      <div
        data-testid="streamdown"
        data-animating={isAnimating}
        data-animated={animatedName}
        data-animated-duration={animatedDuration}
        data-animated-stagger={animatedStagger}
        data-animated-easing={animatedEasing}
        data-caret={caret}
        data-custom-table={Boolean(CustomTable)}
        data-renderer-languages={rendererLanguages}
      >
        <button
          type="button"
          data-testid="streamdown-link"
          onClick={async () => {
            if (!linkSafety?.enabled) return
            const ok = linkSafety.onLinkCheck ? await linkSafety.onLinkCheck(url) : false
            if (ok) return
            setOpen(true)
          }}
        >
          docs
        </button>
        {markdown.startsWith('FILE_PATH:') && CustomLink ? (
          <CustomLink
            href="termul-file-path:src%2Frenderer%2FApp.tsx%3A42"
            data-testid="file-path-link"
          >
            src/renderer/App.tsx:42
          </CustomLink>
        ) : semanticFixture ? (
          <>
            <h1 data-streamdown="heading-1">Compact heading</h1>
            <ul data-streamdown="unordered-list">
              <li data-streamdown="list-item">First item</li>
              <li data-streamdown="list-item">Second item</li>
            </ul>
            <p>
              Use <code>inline()</code> here.
            </p>
            <div data-streamdown="code-block-body">
              <pre>
                <code>const compact = true</code>
              </pre>
            </div>
            <blockquote data-streamdown="blockquote">A concise quote</blockquote>
            {CustomTable ? (
              <CustomTable>
                <thead>
                  <tr>
                    <th>Column</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Value</td>
                  </tr>
                </tbody>
              </CustomTable>
            ) : null}
          </>
        ) : (
          children
        )}
        {linkSafety?.renderModal?.({
          isOpen: open,
          url,
          onClose: () => setOpen(false),
          onConfirm: () => undefined
        })}
      </div>
    )
  }

  const StreamdownContext = React.createContext({ controls: false, isAnimating: false })
  return {
    Streamdown: MockStreamdown,
    defaultRemarkPlugins: {},
    StreamdownContext,
    TableCopyDropdown: ({ children }: { children: ReactNode }) => <>{children}</>,
    TableDownloadDropdown: ({ children }: { children: ReactNode }) => <>{children}</>
  }
})

const { useReducedMotionMock } = vi.hoisted(() => ({
  useReducedMotionMock: vi.fn(() => true)
}))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: useReducedMotionMock
  }
})

function agentMessage(streaming: boolean): ChatMessageType {
  return {
    id: 'agent-1',
    role: 'agent',
    blocks: [{ type: 'text', text: 'Working on it' }],
    streaming,
    timestamp: 0
  }
}

describe('ChatMessage', () => {
  beforeEach(() => {
    openUrlWithSystemBrowser.mockClear()
    openFilePathFromTerminal.mockClear()
    useReducedMotionMock.mockReturnValue(true)
  })

  it('shows the Streamdown caret while the live agent message is streaming', () => {
    render(<ChatMessage message={agentMessage(true)} isLast />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'true')
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-caret', 'block')
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animated', 'false')
  })

  it('passes the fadeIn animation config (duration/easing/stagger) under default motion', () => {
    useReducedMotionMock.mockReturnValue(false)
    render(<ChatMessage message={agentMessage(true)} isLast />)

    const streamdown = screen.getByTestId('streamdown')
    expect(streamdown).toHaveAttribute('data-animated', 'fadeIn')
    expect(streamdown).toHaveAttribute('data-animated-duration', '500')
    expect(streamdown).toHaveAttribute('data-animated-stagger', '150')
    expect(streamdown).toHaveAttribute('data-animated-easing', 'cubic-bezier(0.22, 1, 0.36, 1)')
  })

  it('renders compact markdown semantics for headings, lists, code, quotes, and tables', () => {
    const message: ChatMessageType = {
      ...agentMessage(false),
      blocks: [
        {
          type: 'text',
          text: [
            '# Compact heading',
            '',
            '- First item',
            '- Second item',
            '',
            'Use `inline()` here.',
            '',
            '```ts',
            'const compact = true',
            '```',
            '',
            '> A concise quote',
            '',
            '| Column |',
            '| --- |',
            '| Value |'
          ].join('\n')
        }
      ]
    }
    const { container } = render(<ChatMessage message={message} isLast />)

    const heading = screen.getByRole('heading', { level: 1, name: 'Compact heading' })
    expect(heading).toHaveAttribute('data-streamdown', 'heading-1')

    const list = screen.getByRole('list')
    expect(list.tagName).toBe('UL')
    expect(list).toHaveAttribute('data-streamdown', 'unordered-list')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    const inlineCode = screen.getByText('inline()')
    expect(inlineCode.tagName).toBe('CODE')
    expect(inlineCode.closest('pre')).toBeNull()

    const codeBlock = screen.getByText('const compact = true')
    expect(codeBlock.closest('[data-streamdown="code-block-body"]')).toBeInTheDocument()
    expect(codeBlock.closest('pre')).toBeInTheDocument()

    const quote = screen.getByText('A concise quote')
    expect(quote.tagName).toBe('BLOCKQUOTE')
    expect(quote).toHaveAttribute('data-streamdown', 'blockquote')

    const table = screen.getByRole('table')
    expect(table).toHaveAttribute('data-streamdown', 'table')
    expect(table.closest('[data-streamdown="table-wrapper"]')).toHaveClass(
      'min-w-0',
      'overflow-hidden'
    )
    expect(table.parentElement).toHaveClass('max-w-full', 'overflow-x-auto')
    expect(container.querySelector('.chat-streamdown')).toHaveClass('leading-normal', 'min-w-0')
  })

  it('stops the Streamdown caret when the live agent message finishes', () => {
    render(<ChatMessage message={agentMessage(false)} isLast />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'false')
  })

  it('wires the termul-plan renderer only for non-streaming (historical) messages', () => {
    // Streaming message: the sticky PlanPanel covers the live turn; the
    // inline renderer is deliberately absent so no duplicate plan UI shows.
    const { unmount: unmountStreaming } = render(
      <ChatMessage message={agentMessage(true)} isLast />
    )
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-renderer-languages', '')
    unmountStreaming()

    // Historical message: the termul-plan renderer is attached so a
    // persisted snapshot fence renders an inline read-only PlanPanel.
    render(<ChatMessage message={agentMessage(false)} isLast />)
    expect(screen.getByTestId('streamdown')).toHaveAttribute(
      'data-renderer-languages',
      'termul-plan'
    )
  })

  it('stops the Streamdown caret when a newer timeline item follows', () => {
    render(<ChatMessage message={agentMessage(true)} isLast={false} />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'false')
  })

  it('shows the fallback caret when a live empty terminated fence is stripped', () => {
    const message: ChatMessageType = {
      ...agentMessage(true),
      blocks: [{ type: 'text', text: '```bash\n```' }]
    }

    const { container } = render(<ChatMessage message={message} isLast />)

    expect(screen.queryByTestId('streamdown')).not.toBeInTheDocument()
    expect(container.querySelector('.animate-caret-blink')).toBeInTheDocument()
  })

  it('opens file citations on regular click (no Ctrl/Cmd gate)', async () => {
    const message: ChatMessageType = {
      ...agentMessage(false),
      blocks: [{ type: 'text', text: 'FILE_PATH:src/renderer/App.tsx:42' }]
    }
    render(<ChatMessage message={message} filePathContext={{ cwd: '/project' }} />)

    const filePathLink = screen.getByTitle('Open in editor')
    fireEvent.click(filePathLink)
    await act(async () => undefined)
    expect(openFilePathFromTerminal).toHaveBeenCalledWith('src/renderer/App.tsx:42', {
      cwd: '/project'
    })
  })

  it('does not open file citations on shift-click (allow text selection)', async () => {
    const message: ChatMessageType = {
      ...agentMessage(false),
      blocks: [{ type: 'text', text: 'FILE_PATH:src/renderer/App.tsx:42' }]
    }
    render(<ChatMessage message={message} filePathContext={{ cwd: '/project' }} />)

    const filePathLink = screen.getByTitle('Open in editor')
    fireEvent.click(filePathLink, { shiftKey: true })
    await act(async () => undefined)
    expect(openFilePathFromTerminal).not.toHaveBeenCalled()
  })

  it('opens confirmed links via the system browser and closes the safety dialog', async () => {
    render(<ChatMessage message={agentMessage(false)} isLast />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('streamdown-link'))
    })
    expect(openUrlWithSystemBrowser).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(openUrlWithSystemBrowser).toHaveBeenCalledWith('https://example.com/docs')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  describe('user message with inline skill chips', () => {
    function userMessage(text: string): ChatMessageType {
      return {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text }],
        streaming: false,
        timestamp: 0
      }
    }

    it('renders inline skill chips for token text in a user bubble', () => {
      const text = `use this ${T('git-worktree')} and then ${T('release-version')}`
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage(text)} />
        </TooltipProvider>
      )

      // Each chip name renders as a visible inline pill; the chip's Sparkles
      // icon (lucide-sparkles) is the chip-specific marker.
      expect(screen.getByText('git-worktree')).toBeInTheDocument()
      expect(screen.getByText('release-version')).toBeInTheDocument()
      expect(container.querySelector('.lucide-sparkles')).not.toBeNull()
      // The plain text segments render too (regex tolerates the surrounding
      // whitespace the segment carries next to the chips).
      expect(screen.getByText(/use this/)).toBeInTheDocument()
      expect(screen.getByText(/and then/)).toBeInTheDocument()
    })

    it('renders plain user text verbatim (no chip parsing) when there are no tokens', () => {
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage('just plain text')} />
        </TooltipProvider>
      )
      expect(screen.getByText('just plain text')).toBeInTheDocument()
      // No chip rendered: the chip's Sparkles icon is absent.
      expect(container.querySelector('.lucide-sparkles')).toBeNull()
    })
  })
})
