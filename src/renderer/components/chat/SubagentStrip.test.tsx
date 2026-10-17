import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store/types'
import { SubagentStrip } from './SubagentStrip'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

const user: ChatMessage = {
  id: 'u1',
  role: 'user',
  blocks: [],
  streaming: false,
  timestamp: 1,
  seq: 1
}

function sub(partial: Partial<ToolCall>): ToolCall {
  return {
    toolCallId: 'a1',
    seq: 2,
    timestamp: Date.now(),
    rawInput: {
      description: 'Audit code',
      prompt: 'do it',
      subagent_type: 'general-purpose'
    },
    ...partial
  }
}

function renderStrip(
  toolCalls: ToolCall[],
  extra: { turnActive?: boolean; messages?: ChatMessage[] } = {}
) {
  return render(
    <SubagentStrip
      toolCalls={toolCalls}
      messages={extra.messages ?? [user]}
      turnActive={extra.turnActive ?? true}
      filePathContext={undefined}
    />
  )
}

describe('SubagentStrip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing without current-turn subagents', () => {
    const { container } = renderStrip([
      sub({ seq: 0 }),
      { toolCallId: 'r', kind: 'read', rawInput: { path: 'a' }, seq: 3 }
    ])
    expect(container).toBeEmptyDOMElement()
  })

  it('shows counts and row details', () => {
    renderStrip([
      sub({ toolCallId: 'a', status: 'in_progress' }),
      sub({
        toolCallId: 'b',
        status: 'completed',
        rawInput: { description: 'Write tests', prompt: 'p' },
        subagentUsage: { totalDurationMs: 3574, totalTokens: 37847 }
      }),
      sub({ toolCallId: 'c', status: 'failed' })
    ])
    expect(screen.getByRole('button', { name: /Subagents/ })).toHaveTextContent(
      /1 running.*1 done.*1 failed/
    )
    expect(screen.getByRole('button', { name: /^done\s*Write tests/ })).toHaveTextContent(
      /00:03.*37\.8k tok/
    )
    expect(screen.getAllByText('general-purpose').length).toBeGreaterThan(0)
  })

  it('opens the details dialog from a row', () => {
    renderStrip([sub({ status: 'completed' })])
    fireEvent.click(screen.getByRole('button', { name: /^done\s*Audit code/ }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('toggles the list from the header', () => {
    renderStrip([sub({ status: 'completed' })])
    const header = screen.getByRole('button', { name: /Subagents/ })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  it('ticks the running elapsed time every second and stops when settled', () => {
    const start = Date.now()
    const running = sub({ status: 'in_progress', timestamp: start })
    const { rerender } = renderStrip([running])
    const row = () => screen.getByRole('button', { name: /^running\s*Audit code/ })
    expect(row()).toHaveTextContent('00:00')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(row()).toHaveTextContent('00:03')

    rerender(
      <SubagentStrip
        toolCalls={[{ ...running, status: 'completed' }]}
        messages={[user]}
        turnActive={false}
        filePathContext={undefined}
      />
    )
    // Observed transition: duration is settle time minus start.
    expect(screen.getByRole('button', { name: /^done\s*Audit code/ })).toHaveTextContent('00:03')
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByRole('button', { name: /^done\s*Audit code/ })).toHaveTextContent('00:03')
  })

  it('shows an in-flight call as stopped (counted failed) once the turn ended', () => {
    renderStrip([sub({ status: 'in_progress' })], { turnActive: false })
    expect(screen.getByRole('button', { name: /^stopped\s*Audit code/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Subagents/ })).toHaveTextContent('1 failed')
    expect(screen.queryByRole('button', { name: /^running/ })).toBeNull()
  })

  it('does not tick while collapsed or hidden, and catches up on resume', () => {
    const start = Date.now()
    const running = sub({ status: 'in_progress', timestamp: start })
    const props = { messages: [user], turnActive: true, filePathContext: undefined }
    const { rerender } = render(
      <SubagentStrip toolCalls={[running]} {...props} isVisible={false} />
    )
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(vi.getTimerCount()).toBe(0)
    rerender(<SubagentStrip toolCalls={[running]} {...props} isVisible />)
    expect(screen.getByRole('button', { name: /^running\s*Audit code/ })).toHaveTextContent('00:04')
    fireEvent.click(screen.getByRole('button', { name: /Subagents/ }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the dialog mounted when its call leaves the current turn', () => {
    const call = sub({ status: 'completed' })
    const props = { turnActive: false, filePathContext: undefined }
    const { rerender } = render(<SubagentStrip toolCalls={[call]} messages={[user]} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^done\s*Audit code/ }))
    rerender(
      <SubagentStrip
        toolCalls={[call]}
        messages={[user, { ...user, id: 'u2', seq: 10 }]}
        {...props}
      />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
