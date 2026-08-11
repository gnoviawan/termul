import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolCallStatus } from '@/lib/acp-api'
import { ToolCallCard } from './ToolCallCard'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

const openFilePathFromTerminal = vi.fn(() => Promise.resolve({ ok: true as const }))

vi.mock('@/lib/file-path-links', () => ({
  openFilePathFromTerminal: (...args: unknown[]) => openFilePathFromTerminal(...args)
}))

import { TooltipProvider } from '@/components/ui/tooltip'

function toolCall(status: ToolCallStatus, content: ToolCall['content'] = []): ToolCall {
  return {
    toolCallId: 'tool-1',
    title: 'Read file',
    kind: 'read',
    status,
    content
  }
}

function withTooltip(ui: React.JSX.Element): React.JSX.Element {
  return <TooltipProvider>{ui}</TooltipProvider>
}

describe('ToolCallCard', () => {
  it('shimmers the full card only while in progress', () => {
    const { container, rerender } = render(<ToolCallCard toolCall={toolCall('in_progress')} />)
    const card = container.firstElementChild

    expect(card).toHaveClass('tool-call-card-running')
    expect(card).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument()
    for (const cls of [
      'rounded-lg',
      'bg-card/30',
      'shadow-[0_1px_2px_hsl(var(--foreground)/0.04)]'
    ]) {
      expect(card).not.toHaveClass(cls)
    }

    rerender(<ToolCallCard toolCall={toolCall('pending')} />)
    expect(container.firstElementChild).not.toHaveClass('tool-call-card-running')
    expect(container.firstElementChild).not.toHaveAttribute('aria-busy')

    rerender(<ToolCallCard toolCall={toolCall('completed')} />)
    expect(container.firstElementChild).not.toHaveClass('tool-call-card-running')

    rerender(<ToolCallCard toolCall={toolCall('failed')} />)
    expect(container.firstElementChild).not.toHaveClass('tool-call-card-running')
  })

  it('keeps in-progress tool details interactive', () => {
    render(
      <ToolCallCard
        toolCall={toolCall('in_progress', [
          { type: 'content', content: { type: 'text', text: 'Result' } }
        ])}
      />
    )
    const trigger = screen.getByRole('button')

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Result')).toBeInTheDocument()
  })

  it('renders nested audio controls and embedded resource text', () => {
    render(
      <ToolCallCard
        toolCall={toolCall('completed', [
          {
            type: 'content',
            content: {
              type: 'audio',
              mimeType: 'audio/mpeg',
              data: 'aGVsbG8='
            }
          },
          {
            type: 'content',
            content: {
              type: 'resource',
              name: 'result.txt',
              resource: {
                uri: 'attachment:///result.txt',
                mimeType: 'text/plain',
                text: 'embedded'
              }
            }
          }
        ])}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(document.querySelector('audio')).toHaveAttribute(
      'src',
      'data:audio/mpeg;base64,aGVsbG8='
    )
    expect(document.querySelector('audio')).toHaveAttribute('aria-label', 'Play audio')
    expect(screen.getByText('embedded')).toBeInTheDocument()
    expect(
      screen.getByText('embedded').closest('[data-embedded-resource="result.txt"]')
    ).toBeInTheDocument()
  })

  it('does not auto-load remote nested audio', () => {
    render(
      <ToolCallCard
        toolCall={toolCall('completed', [
          {
            type: 'content',
            content: {
              type: 'audio',
              mimeType: 'audio/mpeg',
              uri: 'https://example.com/audio.mp3'
            }
          }
        ])}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(document.querySelector('audio')).not.toBeInTheDocument()
    expect(screen.getByTitle('audio.mp3')).toBeInTheDocument()
  })

  it('renders text from an unknown content type instead of a bracketed label', () => {
    render(
      <ToolCallCard
        toolCall={toolCall('completed', [{ type: 'blocked', text: 'untracked/modified' }])}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('untracked/modified')).toBeInTheDocument()
    expect(screen.queryByText('[blocked]')).not.toBeInTheDocument()
  })

  it('renders text from a nested object in an unknown content type', () => {
    render(
      <ToolCallCard
        toolCall={toolCall('completed', [{ type: 'blocked', output: { text: 'result' } }])}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('result')).toBeInTheDocument()
    expect(screen.queryByText('[blocked]')).not.toBeInTheDocument()
  })

  it('renders nothing for an unknown content type with no text-like fields', () => {
    const { container } = render(
      <ToolCallCard toolCall={toolCall('completed', [{ type: 'blocked' }])} />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.queryByText('[blocked]')).not.toBeInTheDocument()
    expect(screen.queryByText('blocked')).not.toBeInTheDocument()
    const detail = container.querySelector('[class*="border-l"]')
    expect(detail).toBeEmptyDOMElement()
  })

  it('renders nothing for a content item with a missing content field', () => {
    const { container } = render(
      <ToolCallCard toolCall={toolCall('completed', [{ type: 'content' }])} />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.queryByText('[content]')).not.toBeInTheDocument()
    expect(screen.queryByText('content')).not.toBeInTheDocument()
    const detail = container.querySelector('[class*="border-l"]')
    expect(detail).toBeEmptyDOMElement()
  })

  describe('open file action', () => {
    beforeEach(() => {
      openFilePathFromTerminal.mockClear()
    })

    it('renders an "Open file" button when rawInput has a path and filePathContext is set', () => {
      const call: ToolCall = {
        ...toolCall('completed'),
        rawInput: { path: 'src/foo.ts' }
      }
      render(withTooltip(<ToolCallCard toolCall={call} filePathContext={{ cwd: '/proj' }} />))

      expect(screen.getByRole('button', { name: 'Open file' })).toBeInTheDocument()
    })

    it('renders the "Open file" button last when the row has a disclosure control', () => {
      const now = 10_000
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
      const runningCall: ToolCall = {
        ...toolCall('in_progress', [
          { type: 'content', content: { type: 'text', text: 'Result' } }
        ]),
        rawInput: { path: 'src/foo.ts', startLine: 10, endLine: 20 },
        timestamp: now - 1_500
      }
      const { rerender } = render(
        withTooltip(<ToolCallCard toolCall={runningCall} filePathContext={{ cwd: '/proj' }} />)
      )

      rerender(
        withTooltip(
          <ToolCallCard
            toolCall={{ ...runningCall, status: 'completed' }}
            filePathContext={{ cwd: '/proj' }}
          />
        )
      )

      const disclosure = screen.getByRole('button', { expanded: false })
      const duration = screen.getByText('1.5s')
      const openFileButton = screen.getByRole('button', { name: 'Open file' })
      const row = disclosure.parentElement
      const rowChildren = Array.from(row?.children ?? [])

      expect(screen.getByText('L10-20')).toBeInTheDocument()
      expect(row).not.toBeNull()
      expect(rowChildren.indexOf(duration)).toBeLessThan(rowChildren.indexOf(openFileButton))
      expect(row?.lastElementChild).toBe(openFileButton)
      dateNow.mockRestore()
    })

    it('does not render an "Open file" button when no path is present in rawInput', () => {
      const call: ToolCall = {
        ...toolCall('completed'),
        rawInput: { query: 'foo' },
        kind: 'search'
      }
      const { container } = render(
        withTooltip(<ToolCallCard toolCall={call} filePathContext={{ cwd: '/proj' }} />)
      )

      expect(screen.queryByRole('button', { name: 'Open file' })).not.toBeInTheDocument()
      // Only the disclosure button (when hasDetail) — here there is no
      // content/resultText so no disclosure button either.
      expect(container.querySelector('button')).toBeNull()
    })

    it('does not render an "Open file" button when filePathContext is absent', () => {
      const call: ToolCall = {
        ...toolCall('completed'),
        rawInput: { path: 'src/foo.ts' }
      }
      render(<ToolCallCard toolCall={call} />)

      expect(screen.queryByRole('button', { name: 'Open file' })).not.toBeInTheDocument()
    })

    it('calls openFilePathFromTerminal when the "Open file" button is clicked', () => {
      const call: ToolCall = {
        ...toolCall('completed'),
        rawInput: { path: 'src/foo.ts' }
      }
      const context = { cwd: '/proj' }
      render(withTooltip(<ToolCallCard toolCall={call} filePathContext={context} />))

      fireEvent.click(screen.getByRole('button', { name: 'Open file' }))

      expect(openFilePathFromTerminal).toHaveBeenCalledTimes(1)
      expect(openFilePathFromTerminal).toHaveBeenCalledWith('src/foo.ts', context)
    })

    it('shows a toast when openFilePathFromTerminal fails', async () => {
      const { toast } = await import('sonner')
      const toastError = vi.spyOn(toast, 'error').mockImplementation(() => 'mocked')
      openFilePathFromTerminal.mockResolvedValueOnce({
        ok: false,
        reason: 'not-found' as const,
        message: 'File not found: src/foo.ts'
      })
      const call: ToolCall = {
        ...toolCall('completed'),
        rawInput: { path: 'src/foo.ts' }
      }
      render(withTooltip(<ToolCallCard toolCall={call} filePathContext={{ cwd: '/proj' }} />))

      fireEvent.click(screen.getByRole('button', { name: 'Open file' }))

      await waitFor(() => {
        expect(toastError).toHaveBeenCalledWith('File not found: src/foo.ts')
      })
      toastError.mockRestore()
    })
  })
})
