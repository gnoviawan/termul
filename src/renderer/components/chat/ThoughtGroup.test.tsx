import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/stores/acp-store'
import { ThoughtGroup } from './ThoughtGroup'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

function thought(id: string, text: string, streaming: boolean): ChatMessage {
  return {
    id,
    role: 'thought',
    blocks: [{ type: 'text', text }],
    streaming,
    timestamp: 0
  }
}

describe('ThoughtGroup', () => {
  it('shows Thinking… and expanded content while streaming at live tail', async () => {
    render(<ThoughtGroup messages={[thought('t1', 'Checking the codebase…', true)]} isLiveTail />)
    expect(screen.getByText(/Thinking/)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Checking the codebase…')).toBeInTheDocument()
    })
  })

  it('shows Thought · N lines when settled', () => {
    const { container } = render(
      <ThoughtGroup messages={[thought('t1', 'Line one\nLine two', false)]} isLiveTail={false} />
    )
    expect(screen.getByText(/Thought/)).toBeInTheDocument()
    expect(container.querySelector('.tabular-nums')).toHaveTextContent('2 lines')
  })

  it('joins multiple thought chunks when expanded via trigger click', async () => {
    render(
      <ThoughtGroup
        messages={[thought('t1', 'First chunk', false), thought('t2', 'Second chunk', false)]}
        isLiveTail={false}
      />
    )
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText(/First chunk/)).toBeInTheDocument()
      expect(screen.getByText(/Second chunk/)).toBeInTheDocument()
    })
  })

  it('allows manual toggle after user interaction', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Hidden until open', false)]} isLiveTail={false} />
    )
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Hidden until open')).toBeInTheDocument()
    })
  })
})
