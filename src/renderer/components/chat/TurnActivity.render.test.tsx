import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'
import type { TimelineItem } from './chat-timeline'
import { TurnActivity } from './TurnActivity'
import type { EnterTracker } from './use-enter-tracker'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

const enter: EnterTracker = { animate: () => false, staggerIndex: () => 0 }

function narration(id: string, text: string): TimelineItem {
  const message: ChatMessage = {
    id,
    role: 'agent',
    blocks: [{ type: 'text', text }],
    streaming: false,
    timestamp: 0
  }
  return { kind: 'message', key: id, message }
}

function thought(id: string, text: string, streaming = false): TimelineItem {
  const message: ChatMessage = {
    id,
    role: 'thought',
    blocks: [{ type: 'text', text }],
    streaming,
    timestamp: 0
  }
  return { kind: 'thought-group', key: id, messages: [message] }
}

function command(id: string, cmd: string): TimelineItem {
  const tool: ToolCall = {
    toolCallId: id,
    title: cmd,
    kind: 'execute',
    status: 'completed',
    rawInput: { command: cmd }
  }
  return { kind: 'tool', key: id, tool }
}

function renderSettledTurn(items: TimelineItem[]): void {
  render(
    <TooltipProvider>
      <TurnActivity
        items={items}
        active={false}
        durationMs={5000}
        attentionRequired={false}
        hasFinalResponse
        enter={enter}
        onOpenSubagent={vi.fn()}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Worked for 5s' }))
}

function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('TurnActivity work runs', () => {
  it('folds every thought and tool call between two narration messages into one row', () => {
    renderSettledTurn([
      narration('a', 'Narration A'),
      thought('t1', 'Look at the tests\nThen the build'),
      command('c1', 'npm test'),
      thought('t2', 'Lint next'),
      command('c2', 'npm run lint'),
      command('c3', 'npm run build'),
      narration('b', 'Narration B')
    ])

    const runTriggers = screen.getAllByRole('button', { name: /^Thought 2 times/ })
    expect(runTriggers).toHaveLength(1)
    const run = runTriggers[0]
    expect(run).toHaveTextContent('Thought 2 times, ran 3 commands')
    expect(screen.queryByText(/^Thought$/)).toBeNull()
    expect(screen.queryByText('npm test')).toBeNull()
    expect(precedes(screen.getByText('Narration A'), run)).toBe(true)
    expect(precedes(run, screen.getByText('Narration B'))).toBe(true)

    fireEvent.click(run)

    const rows = within(run.parentElement as HTMLElement)
      .getAllByText(/^(Thought|npm test|npm run lint|npm run build)$/)
      .map((el) => el.textContent)
    expect(rows).toEqual(['Thought', 'npm test', 'Thought', 'npm run lint', 'npm run build'])
  })

  it('keeps a lone thought between two narration messages as a bare thought row', () => {
    renderSettledTurn([
      narration('a', 'Narration A'),
      thought('t1', 'Just one idea'),
      narration('b', 'Narration B')
    ])

    expect(screen.getByRole('button', { name: 'Thought · 1 line' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Thought 1 time|^Thought$/ })).toBeNull()
  })

  it('starts the live run collapsed and streams its thought once opened', () => {
    const before = [
      narration('a', 'Narration A'),
      thought('t1', 'Check the tests'),
      command('c1', 'npm test'),
      thought('t2', 'Now the build', true)
    ]
    const ui = (items: TimelineItem[]): React.JSX.Element => (
      <TooltipProvider>
        <TurnActivity
          items={items}
          active
          durationMs={null}
          attentionRequired={false}
          hasFinalResponse={false}
          enter={enter}
          onOpenSubagent={vi.fn()}
        />
      </TooltipProvider>
    )
    render(ui(before))

    const run = screen.getByRole('button', { name: 'Thought 2 times, ran 1 command' })
    expect(run).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('npm test')).toBeNull()

    fireEvent.click(run)
    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
  })

  it('labels a tool-only run exactly as before', () => {
    renderSettledTurn([
      narration('a', 'Narration A'),
      command('c1', 'npm test'),
      command('c2', 'npm run lint'),
      narration('b', 'Narration B')
    ])

    expect(screen.getByRole('button', { name: 'Ran 2 commands' })).toBeInTheDocument()
  })
})
