import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { QueuedPrompt } from '@/stores/acp-store'

const { mobileRef } = vi.hoisted(() => ({ mobileRef: { current: false } }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current
}))

import { PromptQueuePanel } from './PromptQueuePanel'

function queued(id: string, text: string): QueuedPrompt {
  return { id, createdAt: 1, blocks: [{ type: 'text', text }] }
}

const ITEMS = [
  queued('q1', 'Fix the lint errors'),
  queued('q2', 'Then update the docs'),
  queued('q3', 'Open a PR')
]

function renderPanel(props: Partial<React.ComponentProps<typeof PromptQueuePanel>> = {}) {
  const handlers = {
    onRemove: vi.fn(),
    onSendNow: vi.fn(),
    onMove: vi.fn(),
    onClear: vi.fn(),
    onEdit: vi.fn()
  }
  const view = render(
    <TooltipProvider>
      <PromptQueuePanel items={ITEMS} {...handlers} {...props} />
    </TooltipProvider>
  )
  return { ...view, ...handlers }
}

const rows = () => screen.getAllByRole('listitem')

describe('PromptQueuePanel', () => {
  beforeEach(() => {
    mobileRef.current = false
  })

  it('renders nothing for an empty queue', () => {
    renderPanel({ items: [] })
    expect(screen.queryByTestId('prompt-queue')).toBeNull()
  })

  it('shows the count in a header that collapses the list', () => {
    renderPanel()
    const header = screen.getByRole('button', { name: '3 queued' })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  it('starts collapsed with defaultOpen={false}', () => {
    renderPanel({ defaultOpen: false })
    expect(screen.getByRole('button', { name: '3 queued' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('clears the queue from the header', () => {
    const { onClear } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Clear queue' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('steers, edits and removes a row', () => {
    const { onSendNow, onEdit, onRemove } = renderPanel()
    const second = within(rows()[1])
    fireEvent.click(second.getByRole('button', { name: 'Steer' }))
    expect(onSendNow).toHaveBeenCalledWith('q2')
    fireEvent.click(second.getByRole('button', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledWith(ITEMS[1], 'Then update the docs')
    fireEvent.click(second.getByRole('button', { name: 'Remove from queue' }))
    expect(onRemove).toHaveBeenCalledWith('q2')
  })

  it('offers no Edit for a prompt with files, and names it after the file', () => {
    const withFile: QueuedPrompt = {
      id: 'f1',
      createdAt: 1,
      blocks: [{ type: 'resource_link', uri: 'file:///w/notes.md', name: 'notes.md' }]
    } as QueuedPrompt
    renderPanel({ items: [withFile] })
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.getByTitle('notes.md')).toBeInTheDocument()
  })

  it('reorders a row with the arrow keys on its handle and announces the place', () => {
    const { onMove } = renderPanel()
    const handle = screen.getByRole('button', { name: 'Reorder: Then update the docs' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(onMove).toHaveBeenCalledWith('q2', 0)
    expect(screen.getByText('Moved to place 1 of 3')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder: Fix the lint errors' }), {
      key: 'ArrowUp'
    })
    // Already first: no move.
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('has no drag handle for a single prompt or without onMove', () => {
    const { unmount } = renderPanel({ items: [ITEMS[0]] })
    expect(screen.queryByRole('button', { name: /^Reorder/ })).toBeNull()
    unmount()
    renderPanel({ onMove: undefined })
    expect(screen.queryByRole('button', { name: /^Reorder/ })).toBeNull()
  })

  it('names each action after its row on the phone', () => {
    mobileRef.current = true
    renderPanel()
    expect(screen.getByRole('button', { name: 'Steer: Fix the lint errors' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove from queue: Open a PR' })).toBeInTheDocument()
  })
})
