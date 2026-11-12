import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useToolCallRevealStore } from '@/stores/tool-call-reveal-store'
import type { TimelineItem } from './chat-timeline'
import { SubagentSurfaceContext } from './subagent-surface-context'
import { TurnActivity } from './TurnActivity'
import type { EnterTracker } from './use-enter-tracker'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

const enter: EnterTracker = { animate: () => false, staggerIndex: () => 0 }

function command(id: string): TimelineItem {
  return {
    kind: 'tool',
    key: id,
    tool: {
      toolCallId: id,
      title: id,
      kind: 'execute',
      status: 'completed',
      rawInput: { command: id }
    }
  }
}

function Turn({ items }: { items: TimelineItem[] }): React.JSX.Element {
  return (
    <TooltipProvider>
      <SubagentSurfaceContext.Provider
        value={{
          sessionId: 's1',
          agentId: undefined,
          filePathContext: undefined,
          openId: null,
          opensDialog: false,
          open: () => {}
        }}
      >
        <TurnActivity
          items={items}
          active={false}
          parentTurn="ended"
          durationMs={5000}
          attentionRequired={false}
          hasFinalResponse
          enter={enter}
        />
      </SubagentSurfaceContext.Provider>
    </TooltipProvider>
  )
}

const turn = () => screen.getByRole('button', { name: 'Worked for 5s' })

describe('TurnActivity reveal', () => {
  afterEach(() => {
    useToolCallRevealStore.setState({ target: null })
  })

  it('opens only for a reveal in its own chat, and stays folded once the reader folds it', () => {
    const { rerender } = render(<Turn items={[command('call-1')]} />)
    expect(turn()).toHaveAttribute('aria-expanded', 'false')

    act(() => useToolCallRevealStore.getState().reveal('s2', 'call-1'))
    expect(turn()).toHaveAttribute('aria-expanded', 'false')

    act(() => useToolCallRevealStore.getState().reveal('s1', 'call-1'))
    expect(turn()).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(turn())
    rerender(<Turn items={[command('call-1'), command('call-2')]} />)
    expect(turn()).toHaveAttribute('aria-expanded', 'false')
  })
})
