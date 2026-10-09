import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedPrompt } from '@/stores/acp-store'

const { mobileRef } = vi.hoisted(() => ({ mobileRef: { current: false } }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current
}))

import { PromptQueuePanel } from './PromptQueuePanel'

function queued(id: string, text: string): QueuedPrompt {
  return { id, createdAt: 1, blocks: [{ type: 'text', text }] }
}

const ITEMS = [queued('q1', 'Fix the lint errors'), queued('q2', 'Then update the docs')]

function renderPanel(props: Partial<React.ComponentProps<typeof PromptQueuePanel>> = {}) {
  const onRemove = vi.fn()
  const onSendNow = vi.fn()
  const view = render(
    <PromptQueuePanel items={ITEMS} onRemove={onRemove} onSendNow={onSendNow} {...props} />
  )
  return { ...view, onRemove, onSendNow }
}

describe('PromptQueuePanel', () => {
  beforeEach(() => {
    mobileRef.current = false
  })

  it('renders nothing for an empty queue', () => {
    const { container } = renderPanel({ items: [] })
    expect(container.firstChild).toBeNull()
  })

  describe('desktop baseline', () => {
    it('starts expanded with the shipped action names', () => {
      renderPanel()
      const trigger = screen.getByRole('button', { name: '2 Queued' })
      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      expect(trigger).not.toHaveClass('min-h-11')
      expect(screen.getAllByRole('button', { name: 'Send now' })).toHaveLength(2)
      expect(screen.getAllByRole('button', { name: 'Remove from queue' })).toHaveLength(2)
    })

    it('starts collapsed with defaultOpen={false}', () => {
      renderPanel({ defaultOpen: false })
      expect(screen.getByRole('button', { name: '2 Queued' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    })
  })

  describe('mobile shell', () => {
    beforeEach(() => {
      mobileRef.current = true
    })

    it('shows a collapsed touch-height "2 Queued" trigger with defaultOpen={false}', () => {
      renderPanel({ defaultOpen: false })
      const trigger = screen.getByRole('button', { name: '2 Queued' })
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      expect(trigger).toHaveClass('min-h-11')
    })

    it('expands on tap and names each action after its queued text', async () => {
      const { onSendNow, onRemove } = renderPanel({ defaultOpen: false })
      fireEvent.click(screen.getByRole('button', { name: '2 Queued' }))

      const sendFirst = await screen.findByRole('button', {
        name: 'Send now: Fix the lint errors'
      })
      const removeSecond = screen.getByRole('button', {
        name: 'Remove from queue: Then update the docs'
      })
      expect(screen.getByRole('button', { name: 'Send now: Then update the docs' })).toBeVisible()
      expect(
        screen.getByRole('button', { name: 'Remove from queue: Fix the lint errors' })
      ).toBeVisible()

      fireEvent.click(sendFirst)
      expect(onSendNow).toHaveBeenCalledWith('q1')
      fireEvent.click(removeSecond)
      expect(onRemove).toHaveBeenCalledWith('q2')
    })

    it('falls back to the attachment name, then a placeholder, as the action object', () => {
      renderPanel({
        items: [
          {
            id: 'q3',
            createdAt: 1,
            blocks: [
              { type: 'resource_link', uri: 'file:///work/notes.md', name: 'notes.md' }
            ] as never
          },
          queued('q4', '')
        ]
      })
      expect(screen.getByRole('button', { name: 'Send now: notes.md' })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Remove from queue: (queued message)' })
      ).toBeInTheDocument()
    })
  })
})
