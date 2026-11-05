import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { endedState, subagentToolCall } from '@/lib/test-utils/subagent'
import type { ChatMessage } from '@/stores/acp-store'
import type { TimelineItem } from './chat-timeline'
import { TurnActivity } from './TurnActivity'
import type { ParentTurn } from './tool-call-summary'
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

function dispatch(id: string, title: string): TimelineItem {
  const tool = subagentToolCall(
    { title, state: endedState() },
    { toolCallId: id, status: 'completed' }
  )
  return { kind: 'tool', key: id, tool }
}

const items: TimelineItem[] = [
  narration('m1', 'I will run two reviewers.'),
  dispatch('d1', 'Review the store'),
  dispatch('d2', 'Review the host'),
  narration('m2', 'Waiting for them.')
]

function turn(active: boolean, parentTurn: ParentTurn): React.JSX.Element {
  return (
    <TooltipProvider>
      <TurnActivity
        items={items}
        active={active}
        parentTurn={parentTurn}
        durationMs={active ? null : 5000}
        attentionRequired={false}
        hasFinalResponse
        enter={enter}
      />
    </TooltipProvider>
  )
}

function groupHeaders(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /^2 subagents:/ })
}

describe('TurnActivity subagents', () => {
  it('a settled turn keeps its subagent group in the transcript while folded', () => {
    render(turn(false, 'ended'))
    expect(screen.getByRole('button', { name: 'Worked for 5s' })).toBeInTheDocument()
    expect(screen.queryByText('Waiting for them.')).not.toBeInTheDocument()
    expect(groupHeaders()).toHaveLength(1)
  })

  it('the group stays when a live turn ends and folds', async () => {
    const view = render(turn(true, 'active'))
    expect(groupHeaders()).toHaveLength(1)
    view.rerender(turn(false, 'ended'))
    expect(groupHeaders()).toHaveLength(1)
    await waitFor(() => expect(screen.queryByText('Waiting for them.')).not.toBeInTheDocument())
    expect(groupHeaders()).toHaveLength(1)
  })

  it('opening the turn shows the group once, in its place among the steps', () => {
    render(turn(false, 'superseded'))
    fireEvent.click(screen.getByRole('button', { name: 'Worked for 5s' }))
    const [header] = groupHeaders()
    expect(groupHeaders()).toHaveLength(1)
    const before = screen.getByText('I will run two reviewers.')
    const after = screen.getByText('Waiting for them.')
    expect(before.compareDocumentPosition(header!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(header!.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
