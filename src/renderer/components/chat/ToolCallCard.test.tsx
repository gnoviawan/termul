import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolCallStatus } from '@/lib/acp-api'
import { ToolCallCard } from './ToolCallCard'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

function toolCall(status: ToolCallStatus, withContent = false): ToolCall {
  return {
    toolCallId: 'tool-1',
    title: 'Read file',
    kind: 'read',
    status,
    content: withContent ? [{ type: 'content', content: { type: 'text', text: 'Result' } }] : []
  }
}

describe('ToolCallCard', () => {
  it('shimmers the full card only while in progress', () => {
    const { container, rerender } = render(<ToolCallCard toolCall={toolCall('in_progress')} />)
    const card = container.firstElementChild

    expect(card).toHaveClass('tool-call-card-running')
    expect(card).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument()
    expect(card).not.toHaveClass(
      'rounded-lg',
      'bg-card/30',
      'shadow-[0_1px_2px_hsl(var(--foreground)/0.04)]'
    )

    rerender(<ToolCallCard toolCall={toolCall('pending')} />)
    expect(container.firstElementChild).not.toHaveClass('tool-call-card-running')
    expect(container.firstElementChild).not.toHaveAttribute('aria-busy')

    rerender(<ToolCallCard toolCall={toolCall('completed')} />)
    expect(container.firstElementChild).not.toHaveClass('tool-call-card-running')

    rerender(<ToolCallCard toolCall={toolCall('failed')} />)
    expect(container.firstElementChild).not.toHaveClass('tool-call-card-running')
  })

  it('keeps in-progress tool details interactive', () => {
    render(<ToolCallCard toolCall={toolCall('in_progress', true)} />)
    const trigger = screen.getByRole('button')

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Result')).toBeInTheDocument()
  })
})
