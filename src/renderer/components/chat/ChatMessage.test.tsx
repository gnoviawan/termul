import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { AnimateOptions } from 'streamdown'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  CMD_TOKEN_END,
  CMD_TOKEN_START,
  commandToken,
  fileToken,
  skillToken
} from '@/lib/skill-tokens'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { ChatMessage } from './ChatMessage'

const T = skillToken

const FT = fileToken

const CT = commandToken

const copyTextMock = vi.fn(async () => true)

vi.mock('@/lib/copy-text', () => ({
  copyText: (text: string) => copyTextMock(text)
}))

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
    plugins,
    allowedTags,
    remarkPlugins,
    mode
  }: {
    children: ReactNode
    isAnimating?: boolean
    caret?: string
    animated?: boolean | AnimateOptions
    linkSafety?: LinkSafety
    components?: Record<string, unknown>
    plugins?: { renderers?: { language: string | string[] }[] } & Record<string, unknown>
    allowedTags?: Record<string, string[]>
    remarkPlugins?: unknown[]
    mode?: string
  }): React.JSX.Element {
    const [open, setOpen] = React.useState(false)
    const url = 'https://example.com/docs'
    const markdown = typeof children === 'string' ? children : ''
    const CustomTable = components?.table as React.ElementType | undefined
    const CustomFilePath = components?.['termul-file-path'] as React.ElementType | undefined
    const CustomImage = components?.['termul-image'] as React.ElementType | undefined
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
        data-mode={mode}
        data-animating={isAnimating}
        data-animated={animatedName}
        data-animated-duration={animatedDuration}
        data-animated-stagger={animatedStagger}
        data-animated-easing={animatedEasing}
        data-caret={caret}
        data-custom-table={Boolean(CustomTable)}
        data-renderer-languages={rendererLanguages}
        data-allowed-tags={allowedTags ? JSON.stringify(allowedTags) : ''}
        data-has-file-path-component={Boolean(CustomFilePath)}
        data-has-image-component={Boolean(CustomImage)}
        data-remark-plugins={remarkPlugins ? String(remarkPlugins.length) : ''}
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
        {markdown.startsWith('FILE_PATH:') && CustomFilePath ? (
          <CustomFilePath data-path="src/renderer/App.tsx:42" data-testid="file-path-link">
            src/renderer/App.tsx:42
          </CustomFilePath>
        ) : markdown.startsWith('IMAGE:') && CustomImage ? (
          <CustomImage data-url="output/chart.png" data-alt="chart" />
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
    defaultRemarkPlugins: { gfm: {}, codeMeta: {} },
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
    copyTextMock.mockClear()
  })

  it('shows the Streamdown caret while the live agent message is streaming', () => {
    render(<ChatMessage message={agentMessage(true)} isLast />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'true')
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-caret', 'block')
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animated', 'false')
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-mode', 'streaming')
  })

  it('uses Streamdown blurIn while a live reply streams', () => {
    useReducedMotionMock.mockReturnValue(false)
    render(<ChatMessage message={agentMessage(true)} isLast />)

    const streamdown = screen.getByTestId('streamdown')
    expect(streamdown).toHaveAttribute('data-animated', 'blurIn')
    expect(streamdown).toHaveAttribute('data-animated-duration', '250')
    expect(streamdown).toHaveAttribute('data-animated-easing', 'ease-out')
    expect(streamdown).toHaveAttribute('data-animating', 'true')
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
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-mode', 'static')
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
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-mode', 'static')
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

  it('forwards termul allowedTags, remark plugins, and component overrides to Streamdown', () => {
    const { unmount } = render(<ChatMessage message={agentMessage(false)} isLast />)
    const bare = screen.getByTestId('streamdown')
    // Sanitizer-safe custom tags (hast property names) reach Streamdown.
    expect(bare).toHaveAttribute(
      'data-allowed-tags',
      JSON.stringify({
        'termul-file-path': ['dataPath'],
        'termul-image': ['dataUrl', 'dataAlt']
      })
    )
    // The image rewrite is always on; the file-path plugin waits for a context.
    expect(bare).toHaveAttribute('data-has-image-component', 'true')
    expect(bare).toHaveAttribute('data-has-file-path-component', 'false')
    expect(bare).toHaveAttribute('data-remark-plugins', '3')
    unmount()

    render(
      <ChatMessage message={agentMessage(false)} isLast filePathContext={{ cwd: '/project' }} />
    )
    const withContext = screen.getByTestId('streamdown')
    expect(withContext).toHaveAttribute('data-has-file-path-component', 'true')
    expect(withContext).toHaveAttribute('data-has-image-component', 'true')
    expect(withContext).toHaveAttribute('data-remark-plugins', '4')
  })

  it('renders the muted alt-text chip for relative images without Tauri', () => {
    const message: ChatMessageType = {
      ...agentMessage(false),
      blocks: [{ type: 'text', text: 'IMAGE:' }]
    }
    const { container } = render(<ChatMessage message={message} isLast />)

    expect(screen.getByTestId('termul-image-alt')).toHaveTextContent('chart')
    expect(container.querySelector('img')).toBeNull()
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

      // Each chip name renders as a visible inline pill; the Sparkles icon is
      // the chip-specific marker.
      expect(screen.getByText('git-worktree')).toBeInTheDocument()
      expect(screen.getByText('release-version')).toBeInTheDocument()
      expect(container.querySelector('svg[data-termul-icon="Sparkles"]')).not.toBeNull()
      // The plain text segments render too (regex tolerates the surrounding
      // whitespace the segment carries next to the chips).
      expect(screen.getByText(/use this/)).toBeInTheDocument()
      expect(screen.getByText(/and then/)).toBeInTheDocument()
    })

    it('renders the skill chip as colored text with no background or border', () => {
      render(
        <TooltipProvider>
          <ChatMessage message={userMessage(`use ${T('git-worktree')} now`)} />
        </TooltipProvider>
      )

      // The chip root span (the name span's parent) carries the clean
      // colored-text-only treatment.
      const chip = screen.getByText('git-worktree').parentElement!
      expect(chip).toHaveClass('text-primary', 'font-medium')
      expect(chip).not.toHaveClass('bg-primary/10')
      expect(chip).not.toHaveClass('border')
      expect(chip).not.toHaveClass('border-primary/40')
      expect(chip).not.toHaveClass('px-2')
      expect(chip).not.toHaveClass('rounded-md')
    })

    it('renders plain user text verbatim (no chip parsing) when there are no tokens', () => {
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage('just plain text')} />
        </TooltipProvider>
      )
      expect(screen.getByText('just plain text')).toBeInTheDocument()
      // No chip rendered: the chip's Sparkles icon is absent.
      expect(container.querySelector('svg[data-termul-icon="Sparkles"]')).toBeNull()
    })
  })

  describe('user message with inline file chips', () => {
    function userMessage(text: string): ChatMessageType {
      return {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text }],
        streaming: false,
        timestamp: 0
      }
    }

    it('renders inline file chips for token text in a user bubble', () => {
      const text = `fix this ${FT('auth.ts', '/work/src/auth.ts')} bug`
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage(text)} />
        </TooltipProvider>
      )
      // The file chip name renders as a visible inline pill; the File icon is
      // the chip-specific marker.
      expect(screen.getByText('auth.ts')).toBeInTheDocument()
      expect(container.querySelector('svg[data-termul-icon="File"]')).not.toBeNull()
      // The plain text segments render too.
      expect(screen.getByText(/fix this/)).toBeInTheDocument()
      expect(screen.getByText(/bug/)).toBeInTheDocument()
    })

    it('renders plain user text verbatim (no chip parsing) when there are no tokens', () => {
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage('just plain text')} />
        </TooltipProvider>
      )
      expect(screen.getByText('just plain text')).toBeInTheDocument()
      // No file chip rendered: the File icon is absent.
      expect(container.querySelector('svg[data-termul-icon="File"]')).toBeNull()
    })

    it('renders file + skill chips together (both inline, visually distinct)', () => {
      const text = `use ${T('git-worktree')} on ${FT('auth.ts', '/work/src/auth.ts')}`
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage(text)} />
        </TooltipProvider>
      )
      expect(screen.getByText('git-worktree')).toBeInTheDocument()
      expect(screen.getByText('auth.ts')).toBeInTheDocument()
      // Both icons present — skill (Sparkles) + file (File).
      expect(container.querySelector('svg[data-termul-icon="Sparkles"]')).not.toBeNull()
      expect(container.querySelector('svg[data-termul-icon="File"]')).not.toBeNull()
    })

    it('renders the file chip as muted colored text with no background or border', () => {
      render(
        <TooltipProvider>
          <ChatMessage message={userMessage(`fix ${FT('auth.ts', '/work/src/auth.ts')} now`)} />
        </TooltipProvider>
      )

      const chip = screen.getByText('auth.ts').parentElement!
      expect(chip).toHaveClass('text-muted-foreground', 'font-medium')
      expect(chip).not.toHaveClass('bg-muted/60')
      expect(chip).not.toHaveClass('border')
      expect(chip).not.toHaveClass('border-border/60')
      expect(chip).not.toHaveClass('px-2')
      expect(chip).not.toHaveClass('rounded-md')
    })
  })

  describe('user message with inline command chips', () => {
    function userMessage(text: string): ChatMessageType {
      return {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text }],
        streaming: false,
        timestamp: 0
      }
    }

    it('renders the command chip for token text in a user bubble', () => {
      const text = `${CT('compact')} please summarize`
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage(text)} />
        </TooltipProvider>
      )

      // The command token renders as a SkillChip with the name prefixed by
      // `/` (same visual source of truth as the composer's CommandPill).
      expect(screen.getByText('/compact')).toBeInTheDocument()
      expect(container.querySelector('svg[data-termul-icon="Sparkles"]')).not.toBeNull()
      expect(screen.getByText(/please summarize/)).toBeInTheDocument()
    })

    it('renders command + skill + file chips together in order', () => {
      const text = `${CT('compact')} use ${T('git-worktree')} on ${FT('auth.ts', '/work/src/auth.ts')}`
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage(text)} />
        </TooltipProvider>
      )
      expect(screen.getByText('/compact')).toBeInTheDocument()
      expect(screen.getByText('git-worktree')).toBeInTheDocument()
      expect(screen.getByText('auth.ts')).toBeInTheDocument()
      expect(container.querySelector('svg[data-termul-icon="Sparkles"]')).not.toBeNull()
      expect(container.querySelector('svg[data-termul-icon="File"]')).not.toBeNull()
    })

    it('renders the command chip as primary-colored text (clean treatment)', () => {
      render(
        <TooltipProvider>
          <ChatMessage message={userMessage(`${CT('compact')} hello`)} />
        </TooltipProvider>
      )

      const chip = screen.getByText('/compact').parentElement!
      expect(chip).toHaveClass('text-primary', 'font-medium')
      expect(chip).not.toHaveClass('bg-primary/10')
      expect(chip).not.toHaveClass('border')
      expect(chip).not.toHaveClass('px-2')
      expect(chip).not.toHaveClass('rounded-md')
    })

    it('degrades a malformed command token (no close sentinel) to plain text', () => {
      const text = `broken ${CMD_TOKEN_START}compact`
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage(text)} />
        </TooltipProvider>
      )
      // No crash; no chip rendered (no SkillChip Sparkles, no FileChip File
      // icon, no `/compact` chip text).
      expect(container.querySelector('svg[data-termul-icon="Sparkles"]')).toBeNull()
      expect(container.querySelector('svg[data-termul-icon="File"]')).toBeNull()
      expect(screen.queryByText('/compact')).toBeNull()
      // The malformed sentinel stays inside a plain text span (raw render).
      expect(screen.getByText(/broken/).textContent).toBe(text)
    })

    it('degrades an empty-name command token to plain text', () => {
      const text = `x ${CMD_TOKEN_START}${CMD_TOKEN_END} y`
      const { container } = render(
        <TooltipProvider>
          <ChatMessage message={userMessage(text)} />
        </TooltipProvider>
      )
      // No chip rendered; the sentinel pair stays inside a plain text span.
      expect(container.querySelector('svg[data-termul-icon="Sparkles"]')).toBeNull()
      expect(container.querySelector('svg[data-termul-icon="File"]')).toBeNull()
      expect(screen.getByText(/x /).textContent).toBe(text)
    })

    it('copies sanitized text with /name and no private-use sentinels', async () => {
      const text = `${CT('compact')} hello`
      render(
        <TooltipProvider>
          <ChatMessage message={userMessage(text)} />
        </TooltipProvider>
      )

      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

      await waitFor(() => {
        expect(copyTextMock).toHaveBeenCalledWith('/compact hello')
      })
      for (const call of copyTextMock.mock.calls) {
        expect(call[0]).not.toMatch(/[\uE000-\uE007]/)
      }
    })
  })

  describe('streaming-tail markdown throttle', () => {
    function streamingMessage(text: string, streaming = true): ChatMessageType {
      return {
        id: 'agent-1',
        role: 'agent',
        blocks: [{ type: 'text', text }],
        streaming,
        timestamp: 0
      }
    }

    /** The markdown string Streamdown's children actually rendered. */
    function renderedMarkdown(): string {
      return screen.getByTestId('streamdown').textContent ?? ''
    }

    it('commits the streaming tail at most once per 100 ms (trailing edge)', () => {
      vi.useFakeTimers()
      try {
        let message = streamingMessage('alpha')
        const { rerender } = render(<ChatMessage message={message} isLast />)
        expect(renderedMarkdown()).toContain('alpha')

        // Burst of flushes inside the 100 ms window: Streamdown children
        // must stay at the last committed value.
        for (let i = 1; i <= 5; i++) {
          message = streamingMessage(`alpha-${i}`)
          rerender(<ChatMessage message={message} isLast />)
        }
        expect(renderedMarkdown()).toContain('alpha')
        expect(renderedMarkdown()).not.toContain('alpha-')

        // The trailing edge fires at the window boundary with the latest text.
        act(() => {
          vi.advanceTimersByTime(100)
        })
        expect(renderedMarkdown()).toContain('alpha-5')

        // A burst after the window: held, then one trailing commit.
        for (let i = 6; i <= 8; i++) {
          message = streamingMessage(`alpha-${i}`)
          rerender(<ChatMessage message={message} isLast />)
        }
        expect(renderedMarkdown()).toContain('alpha-5')
        act(() => {
          vi.advanceTimersByTime(100)
        })
        expect(renderedMarkdown()).toContain('alpha-8')
      } finally {
        vi.useRealTimers()
      }
    })

    it('commits the exact final text immediately and synchronously at turn end', () => {
      vi.useFakeTimers()
      try {
        let message = streamingMessage('alpha')
        const { rerender } = render(<ChatMessage message={message} isLast />)

        // A late chunk lands inside the window — held back…
        message = streamingMessage('final answer')
        rerender(<ChatMessage message={message} isLast />)
        expect(renderedMarkdown()).toContain('alpha')

        // …and the turn ends in the same flush: the very render that flips
        // streaming to false carries the exact final text — no timers, no
        // extra frames.
        message = streamingMessage('final answer', false)
        rerender(<ChatMessage message={message} isLast />)
        expect(renderedMarkdown()).toBe('docsfinal answer')
        expect(vi.getTimerCount()).toBe(0)

        // No stale trailing commit lands later.
        act(() => {
          vi.advanceTimersByTime(1_000)
        })
        expect(renderedMarkdown()).toBe('docsfinal answer')
      } finally {
        vi.useRealTimers()
      }
    })

    it('renders historical (non-streaming) messages unthrottled', () => {
      vi.useFakeTimers()
      try {
        let message = streamingMessage('history-a', false)
        const { rerender } = render(<ChatMessage message={message} isLast />)
        expect(renderedMarkdown()).toContain('history-a')

        // Historical messages never accumulate a trailing timer…
        expect(vi.getTimerCount()).toBe(0)

        // …and every text change reaches Streamdown immediately.
        message = streamingMessage('history-b', false)
        rerender(<ChatMessage message={message} isLast />)
        expect(renderedMarkdown()).toContain('history-b')
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
