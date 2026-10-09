import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueueItemAction } from '@/components/ai-elements/queue'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { ComposerPill } from './ComposerPill'
import { ComposerSendButton } from './composer/ComposerSendButton'

/**
 * Landscape floor (L-24): beside every pane-width step down to 40px, a
 * `pointer-coarse:@[400px]:` class restores the 44px target for touch. jsdom
 * evaluates no media or container query, so each site is asserted as class
 * tokens: the narrow 44px class, the 40px step for a fine pointer in a wide
 * pane, and the coarse restore. The compiled order is pinned in
 * `chat-layout.test.ts`.
 */
function tokens(element: Element | null | undefined): string[] {
  expect(element).toBeTruthy()
  return (element?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
}

describe('composer pill (mode, model and config selectors)', () => {
  it('keeps the 44px hit-slop on a coarse pointer in a wide pane, and 40px for a fine one', () => {
    render(<ComposerPill>Model</ComposerPill>)

    expect(tokens(screen.getByRole('button', { name: 'Model' }))).toEqual(
      expect.arrayContaining([
        'after:-inset-y-1.5',
        '@[400px]:after:-inset-y-1',
        'pointer-coarse:@[400px]:after:-inset-y-1.5'
      ])
    )
  })
})

describe('composer send button', () => {
  function renderButton(showStop: boolean): void {
    render(
      <ComposerSendButton
        showStop={showStop}
        canSend
        busy={false}
        reduced
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
  }

  it('send keeps the 44px hit-slop on a coarse pointer in a wide pane', () => {
    renderButton(false)

    expect(tokens(screen.getByRole('button', { name: 'Send message' }))).toEqual(
      expect.arrayContaining([
        'after:-inset-1.5',
        '@[400px]:after:-inset-1',
        'pointer-coarse:@[400px]:after:-inset-1.5'
      ])
    )
  })

  it('stop keeps the 44px hit-slop on a coarse pointer in a wide pane', () => {
    renderButton(true)

    expect(tokens(screen.getByRole('button', { name: 'Cancel turn' }))).toEqual(
      expect.arrayContaining([
        'after:-inset-1.5',
        '@[400px]:after:-inset-1',
        'pointer-coarse:@[400px]:after:-inset-1.5'
      ])
    )
  })
})

describe('queue item action', () => {
  it('keeps the 44px box on a coarse pointer in a wide pane, and 40px for a fine one', () => {
    render(<QueueItemAction aria-label="Remove from queue" />)

    expect(tokens(screen.getByRole('button', { name: 'Remove from queue' }))).toEqual(
      expect.arrayContaining([
        'h-11',
        'w-11',
        '@[400px]:h-10',
        '@[400px]:w-10',
        'pointer-coarse:@[400px]:h-11',
        'pointer-coarse:@[400px]:w-11'
      ])
    )
  })
})

describe('jump to latest button', () => {
  it('keeps the 44px box on a coarse pointer in a wide pane, and 40px for a fine one', async () => {
    render(
      <MessageScrollerProvider>
        <MessageScroller>
          <MessageScrollerViewport data-testid="viewport">
            <div />
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    )
    // Scrolled away from the live edge: distance 800 is past the pin threshold.
    const viewport = screen.getByTestId('viewport')
    Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(viewport, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(viewport, 'scrollTop', { value: 0, configurable: true })
    act(() => {
      fireEvent.scroll(viewport)
    })

    const button = await screen.findByRole('button', { name: 'Scroll to latest' })
    expect(tokens(button)).toEqual(
      expect.arrayContaining(['size-11', '@[400px]:size-10', 'pointer-coarse:@[400px]:size-11'])
    )
  })
})
