import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { ChatMessage } from './ChatMessage'

vi.mock('streamdown', () => ({
  Streamdown: ({
    children,
    isAnimating,
    caret
  }: {
    children: ReactNode
    isAnimating?: boolean
    caret?: string
  }) => (
    <div data-testid="streamdown" data-animating={isAnimating} data-caret={caret}>
      {children}
    </div>
  )
}))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
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
  it('shows the Streamdown caret while the live agent message is streaming', () => {
    render(<ChatMessage message={agentMessage(true)} isLast />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'true')
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-caret', 'block')
  })

  it('stops the Streamdown caret when the live agent message finishes', () => {
    render(<ChatMessage message={agentMessage(false)} isLast />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'false')
  })

  it('stops the Streamdown caret when a newer timeline item follows', () => {
    render(<ChatMessage message={agentMessage(true)} isLast={false} />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'false')
  })
})
