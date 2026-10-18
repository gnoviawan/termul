import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

    it('matches the Changed files panel: no press-scale, same text sizes', () => {
      renderPanel()
      const trigger = screen.getByRole('button', { name: '2 Queued' })
      // The global press-scale (index.css) would shrink the header on hold.
      expect(trigger).toHaveAttribute('data-press-feedback', 'off')
      expect(trigger).toHaveClass('text-xs', 'active:bg-secondary/80', 'select-none')
      expect(trigger).not.toHaveClass('text-sm')
      const row = screen.getByText('Fix the lint errors')
      expect(row).toHaveClass('text-2xs')
      expect(row).not.toHaveClass('text-sm')
    })

    it('shows the Changed files keyboard-focus ring on the header', () => {
      renderPanel()
      expect(screen.getByRole('button', { name: '2 Queued' })).toHaveClass(
        'focus-visible:bg-secondary/60',
        'focus-visible:outline-hidden',
        'focus-visible:ring-2',
        'focus-visible:ring-inset',
        'focus-visible:ring-ring'
      )
    })

    it('keeps the forced-colors focus outline inside the header so the composer cannot cover it', () => {
      renderPanel({ defaultOpen: false })
      expect(screen.getByRole('button', { name: '2 Queued' })).toHaveClass(
        'forced-colors:focus-visible:-outline-offset-2'
      )
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
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Send now: Then update the docs' })).toBeVisible()
        expect(
          screen.getByRole('button', { name: 'Remove from queue: Fix the lint errors' })
        ).toBeVisible()
      })

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
