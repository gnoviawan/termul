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
    const { container } = render(
      <ThoughtGroup messages={[thought('t1', 'Checking the codebase…', true)]} isLiveTail />
    )
    expect(screen.getByText(/Thinking/)).toBeInTheDocument()
    const shimmer = container.querySelector('.t-shimmer')
    expect(shimmer).toBeInTheDocument()
    expect(shimmer).toHaveAttribute('data-text', 'Thinking…')
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

  it('renders content inside a scrollable box with max-height by default', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Some thinking text', false)]} isLiveTail={false} />
    )
    // Open the collapsible
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    // The content container should have max-h class
    const contentDiv = screen.getByText('Some thinking text').closest('div[class*="overflow-y-auto"]')
    expect(contentDiv).toBeInTheDocument()
    expect(contentDiv?.className).toContain('max-h-[200px]')
    expect(contentDiv?.className).toContain('overflow-y-auto')
  })

  it('shows More/Less expand toggle button', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Some thinking text', false)]} isLiveTail={false} />
    )
    // Open the collapsible
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    // "More" button should be visible
    expect(screen.getByText('More')).toBeInTheDocument()
  })

  it('toggles between More and Less on click', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Some thinking text', false)]} isLiveTail={false} />
    )
    // Open the collapsible
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    // Click "More" to expand
    const moreButton = screen.getByText('More')
    fireEvent.click(moreButton)
    expect(screen.getByText('Less')).toBeInTheDocument()
    // The content container should no longer have max-h
    const contentDiv = screen.getByText('Some thinking text').closest('div[class*="overflow-y-auto"]')
    expect(contentDiv?.className).not.toContain('max-h-[200px]')
    // Click "Less" to collapse
    fireEvent.click(screen.getByText('Less'))
    expect(screen.getByText('More')).toBeInTheDocument()
    const contentDivAgain = screen.getByText('Some thinking text').closest('div[class*="overflow-y-auto"]')
    expect(contentDivAgain?.className).toContain('max-h-[200px]')
  })

  it('resets expanded state when collapsible is closed and reopened', async () => {
    render(
      <ThoughtGroup messages={[thought('t1', 'Some thinking text', false)]} isLiveTail={false} />
    )
    // Open and expand
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('More'))
    expect(screen.getByText('Less')).toBeInTheDocument()
    // Close the collapsible
    fireEvent.click(screen.getByText(/Thought/))
    // Re-open — should be back to "More" (collapsed box)
    fireEvent.click(screen.getByText(/Thought/))
    await waitFor(() => {
      expect(screen.getByText('Some thinking text')).toBeInTheDocument()
    })
    expect(screen.getByText('More')).toBeInTheDocument()
  })
})
