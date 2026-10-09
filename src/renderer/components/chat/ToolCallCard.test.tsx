import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolCallStatus } from '@/lib/acp-api'
import { SubagentDetailsDialog } from './SubagentDetailsDialog'
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

/**
 * ToolCallCard requires `onOpenSubagent` — the chat list owns the details
 * dialog so it survives virtualized row removal. Tests that don't exercise
 * delegation pass a no-op stub.
 */
function Card(props: React.ComponentProps<typeof ToolCallCard>): React.JSX.Element {
  return <ToolCallCard {...props} onOpenSubagent={props.onOpenSubagent ?? vi.fn()} />
}

describe('ToolCallCard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens read-only delegation details while a subagent is running', () => {
    const onOpenSubagent = vi.fn()
    const delegatedCall: ToolCall = {
      toolCallId: 'task-1',
      title: 'Audit branch code for slop',
      kind: 'think',
      status: 'in_progress',
      rawInput: {
        subagent_type: 'explorer',
        description: 'Audit branch code for slop',
        prompt: 'Inspect the branch without changing files.'
      }
    }
    render(<ToolCallCard toolCall={delegatedCall} onOpenSubagent={onOpenSubagent} />)

    fireEvent.click(screen.getByRole('button', { name: /audit branch code for slop/i }))

    // The card reports the request; the chat list owns the dialog so it
    // survives virtualized row removal.
    expect(onOpenSubagent).toHaveBeenCalledTimes(1)
    expect(onOpenSubagent).toHaveBeenCalledWith(delegatedCall)
    render(
      <SubagentDetailsDialog
        toolCall={onOpenSubagent.mock.calls[0][0]}
        parentTurnActive
        open
        onOpenChange={() => {}}
      />
    )
    const dialog = screen.getByRole('dialog', { name: 'Audit branch code for slop' })
    expect(dialog).toHaveTextContent('Inspect the branch without changing files.')
    expect(dialog).toHaveTextContent('Running')
  })

  it('shows the activity kind on a running delegation', () => {
    const delegatedCall: ToolCall = {
      toolCallId: 'task-activity',
      title: 'Explore the tree',
      kind: 'think',
      status: 'in_progress',
      rawInput: {
        subagent_type: 'explorer',
        prompt: 'Look around.',
        activityKind: 'exploring'
      }
    }
    render(
      <SubagentDetailsDialog
        toolCall={delegatedCall}
        parentTurnActive
        open
        onOpenChange={() => {}}
      />
    )
    expect(screen.getByRole('dialog', { name: 'Explore the tree' })).toHaveTextContent(
      'Running · exploring'
    )
  })

  it('renders markdown in the delegation result', async () => {
    const delegatedCall: ToolCall = {
      toolCallId: 'task-markdown',
      title: 'Summarize findings',
      kind: 'think',
      status: 'completed',
      rawInput: {
        subagent_type: 'explorer',
        description: 'Summarize findings',
        prompt: 'Summarize the files.'
      },
      rawOutput: { text: '**Important**\n\n- first item\n- second item\n\nUse `status`.' }
    }
    const onOpenSubagent = vi.fn()
    render(<ToolCallCard toolCall={delegatedCall} onOpenSubagent={onOpenSubagent} />)

    fireEvent.click(screen.getByRole('button', { name: /summarize findings/i }))

    expect(onOpenSubagent).toHaveBeenCalledWith(delegatedCall)
    render(
      <SubagentDetailsDialog
        toolCall={onOpenSubagent.mock.calls[0][0]}
        open
        onOpenChange={() => {}}
      />
    )
    const dialog = screen.getByRole('dialog', { name: 'Summarize findings' })
    expect(await within(dialog).findByText('Important')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Important').closest('[data-streamdown="strong"]')
    ).not.toBeNull()
    expect(within(dialog).getByRole('list')).toBeInTheDocument()
    expect(
      within(dialog).getByText('status').closest('[data-streamdown="inline-code"]')
    ).not.toBeNull()
    expect(within(dialog).queryByText('**Important**')).not.toBeInTheDocument()
  })

  it('shimmers the label text in the present tense only while running', () => {
    const { container, rerender } = render(<Card toolCall={toolCall('in_progress')} />)
    const card = container.firstElementChild
    const shimmer = (): Element | null => container.querySelector('.t-shimmer')

    expect(card).toHaveAttribute('aria-busy', 'true')
    expect(shimmer()).toHaveAttribute('data-text', 'Reading Read file…')
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument()
    for (const cls of [
      'rounded-lg',
      'bg-card/30',
      'shadow-[0_1px_2px_oklch(var(--foreground)/0.04)]'
    ]) {
      expect(card).not.toHaveClass(cls)
    }

    rerender(<Card toolCall={toolCall('pending')} />)
    expect(shimmer()).toBeInTheDocument()
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true')

    rerender(<Card toolCall={toolCall('completed')} />)
    expect(shimmer()).not.toBeInTheDocument()
    expect(container.firstElementChild).not.toHaveAttribute('aria-busy')
    expect(screen.getByText('Read')).toBeInTheDocument()

    rerender(<Card toolCall={toolCall('failed')} />)
    expect(shimmer()).not.toBeInTheDocument()
  })

  it('renders the failed outcome an agent reports after a cancelled permission', () => {
    // ACP has no denied status: after a permission is denied or cancelled the
    // agent marks the call failed, and the row is where that outcome shows.
    const { container } = render(<Card toolCall={toolCall('failed')} />)

    const card = container.firstElementChild
    expect(card).toHaveAttribute('data-status', 'failed')
    expect(card).not.toHaveAttribute('aria-busy')
    expect(container.querySelector('.t-shimmer')).not.toBeInTheDocument()
    expect(container.querySelector('span.font-medium')).toHaveClass('text-destructive')
    // The tool glyph and the trailing alert icon are both destructive.
    expect(container.querySelectorAll('svg.text-destructive')).toHaveLength(2)
  })

  it('keeps in-progress tool details interactive', () => {
    render(
      <Card
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
      <Card
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
      <Card
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
      <Card toolCall={toolCall('completed', [{ type: 'blocked', text: 'untracked/modified' }])} />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('untracked/modified')).toBeInTheDocument()
    expect(screen.queryByText('[blocked]')).not.toBeInTheDocument()
  })

  it('renders text from a nested object in an unknown content type', () => {
    render(
      <Card toolCall={toolCall('completed', [{ type: 'blocked', output: { text: 'result' } }])} />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('result')).toBeInTheDocument()
    expect(screen.queryByText('[blocked]')).not.toBeInTheDocument()
  })

  it('renders nothing for an unknown content type with no text-like fields', () => {
    const { container } = render(<Card toolCall={toolCall('completed', [{ type: 'blocked' }])} />)

    fireEvent.click(screen.getByRole('button'))

    expect(screen.queryByText('[blocked]')).not.toBeInTheDocument()
    expect(screen.queryByText('blocked')).not.toBeInTheDocument()
    const detail = container.querySelector('[class*="border-l"]')
    expect(detail).toBeEmptyDOMElement()
  })

  it('renders nothing for a content item with a missing content field', () => {
    const { container } = render(<Card toolCall={toolCall('completed', [{ type: 'content' }])} />)

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
      render(withTooltip(<Card toolCall={call} filePathContext={{ cwd: '/proj' }} />))

      expect(screen.getByRole('button', { name: 'Open file' })).toBeInTheDocument()
    })

    it('renders the "Open file" button last when the row has a disclosure control', () => {
      const now = 10_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const runningCall: ToolCall = {
        ...toolCall('in_progress', [
          { type: 'content', content: { type: 'text', text: 'Result' } }
        ]),
        rawInput: { path: 'src/foo.ts', startLine: 10, endLine: 20 },
        timestamp: now - 1_500
      }
      const { rerender } = render(
        withTooltip(<Card toolCall={runningCall} filePathContext={{ cwd: '/proj' }} />)
      )

      rerender(
        withTooltip(
          <Card
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
    })

    it('does not render an "Open file" button when no path is present in rawInput', () => {
      const call: ToolCall = {
        ...toolCall('completed'),
        rawInput: { query: 'foo' },
        kind: 'search'
      }
      const { container } = render(
        withTooltip(<Card toolCall={call} filePathContext={{ cwd: '/proj' }} />)
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
      render(<Card toolCall={call} />)

      expect(screen.queryByRole('button', { name: 'Open file' })).not.toBeInTheDocument()
    })

    it('calls openFilePathFromTerminal when the "Open file" button is clicked', () => {
      const call: ToolCall = {
        ...toolCall('completed'),
        rawInput: { path: 'src/foo.ts' }
      }
      const context = { cwd: '/proj' }
      render(withTooltip(<Card toolCall={call} filePathContext={context} />))

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
      render(withTooltip(<Card toolCall={call} filePathContext={{ cwd: '/proj' }} />))

      fireEvent.click(screen.getByRole('button', { name: 'Open file' }))

      await waitFor(() => {
        expect(toastError).toHaveBeenCalledWith('File not found: src/foo.ts')
      })
      toastError.mockRestore()
    })
  })
})

describe('ToolCallCard read results', () => {
  const read = (path: string): ToolCall => ({
    toolCallId: 'read-1',
    title: 'Read file',
    kind: 'read',
    status: 'completed',
    rawInput: { path },
    rawOutput: { content: 'const answer = 42\n' }
  })

  it('syntax highlights file contents by the file extension', async () => {
    const { container } = render(<Card toolCall={read('src/app.ts')} />)
    fireEvent.click(screen.getByRole('button'))

    const block = container.querySelector('pre[data-language]')
    expect(block).toHaveAttribute('data-language', 'typescript')
    expect(block).toHaveTextContent('const answer = 42')
    await waitFor(() => {
      const colored = [...container.querySelectorAll('pre span')].filter((span) =>
        (span as HTMLElement).style.getPropertyValue('--dtok')
      )
      expect(colored.length).toBeGreaterThan(0)
    })
    expect(block).toHaveTextContent('const answer = 42')
  })

  it('keeps unknown file types as plain text', () => {
    const { container } = render(<Card toolCall={read('notes.unknownext')} />)
    fireEvent.click(screen.getByRole('button'))
    expect(container.querySelector('pre[data-language]')).toHaveAttribute(
      'data-language',
      'plaintext'
    )
    expect(container.querySelector('pre span')).toBeNull()
  })
})
