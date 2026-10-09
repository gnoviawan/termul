import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalContextMenu } from '@/components/GlobalContextMenu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isInertExemptOverlay } from '@/hooks/use-inert-behind-overlays'
import { commandToken, fileToken, sanitizeDisplayText, skillToken } from '@/lib/skill-tokens'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ChatMessage } from './ChatMessage'
import { resetLongPressFallbackLogForTests } from './MessageActions'

const { mobileShellMock, copyTextMock, logFrontendErrorMock, toastErrorMock } = vi.hoisted(() => ({
  mobileShellMock: vi.fn(() => true),
  copyTextMock: vi.fn(async (_text: string) => true),
  logFrontendErrorMock: vi.fn(async (_payload: Record<string, unknown>) => {}),
  toastErrorMock: vi.fn()
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileShellMock()
}))

vi.mock('@/lib/copy-text', () => ({
  copyText: (text: string) => copyTextMock(text)
}))

vi.mock('@/lib/log-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/log-api')>('@/lib/log-api')
  return {
    ...actual,
    logFrontendError: (payload: Record<string, unknown>) => logFrontendErrorMock(payload)
  }
})

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) }
}))

vi.mock('@/lib/api', () => ({
  openerApi: { openUrlWithSystemBrowser: vi.fn(() => Promise.resolve({ success: true })) }
}))

vi.mock('@/lib/file-path-links', () => ({
  openFilePathFromTerminal: vi.fn(() => Promise.resolve({ ok: true as const }))
}))

vi.mock('streamdown', async () => {
  const React = await import('react')
  const { createPortal } = await import('react-dom')
  // Text containing `[portal]` also renders a portaled control, standing in for
  // the link-safety dialog / lightbox: a React child of the message whose DOM
  // lives under <body>.
  function MockStreamdown({ children }: { children: ReactNode }): React.JSX.Element {
    return (
      <div data-testid="streamdown">
        {children}
        {typeof children === 'string' && children.includes('[portal]')
          ? createPortal(
              <button type="button" data-testid="portaled-control">
                portaled
              </button>,
              document.body
            )
          : null}
      </div>
    )
  }
  const StreamdownContext = React.createContext({ controls: false, isAnimating: false })
  return {
    Streamdown: MockStreamdown,
    defaultRemarkPlugins: { gfm: {}, codeMeta: {} },
    StreamdownContext,
    TableCopyDropdown: ({ children }: { children: ReactNode }) => <>{children}</>,
    TableDownloadDropdown: ({ children }: { children: ReactNode }) => <>{children}</>
  }
})

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

const MENU_PREFIX = 'message-actions-menu:'

function userMessage(text = 'hello there', id = 'user-1'): ChatMessageType {
  return { id, role: 'user', blocks: [{ type: 'text', text }], streaming: false, timestamp: 0 }
}

function agentMessage(streaming = false, text = 'Working on it', id = 'agent-1'): ChatMessageType {
  return { id, role: 'agent', blocks: [{ type: 'text', text }], streaming, timestamp: 0 }
}

function renderMessage(ui: ReactNode, options: { global?: boolean } = {}): HTMLElement {
  const tree = <TooltipProvider>{ui}</TooltipProvider>
  const { container } = render(
    options.global ? <GlobalContextMenu>{tree}</GlobalContextMenu> : tree
  )
  return container
}

function messageElement(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-slot="message"]')
  if (!el) throw new Error('message element not found')
  return el
}

const MENU_CASES = [
  {
    label: 'user message',
    ui: () => <ChatMessage message={userMessage()} onEdit={() => {}} />,
    items: ['Copy', 'Edit']
  },
  {
    label: 'agent turn tail',
    ui: () => <ChatMessage message={agentMessage()} isTurnTail onRetry={() => {}} />,
    items: ['Copy', 'Retry']
  }
]

// jsdom does not know `-webkit-touch-callout`, so React's assignment lands only
// on the style object (not in the `style` attribute): read it from there.
function touchCallout(el: HTMLElement): unknown {
  return (el.style as unknown as Record<string, unknown>).WebkitTouchCallout
}

function actionsRow(): HTMLElement {
  const row = screen
    .getByRole('button', { name: 'Copy' })
    .closest<HTMLElement>('.transition-opacity')
  if (!row) throw new Error('actions row not found')
  return row
}

async function openMenuWithContextMenuKey(el: HTMLElement): Promise<string[]> {
  fireEvent.contextMenu(el)
  const items = await screen.findAllByRole('menuitem')
  return items.map((item) => item.textContent?.trim() ?? '')
}

async function expectMenuClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0))
}

function infoLogs(): Array<Record<string, unknown>> {
  return logFrontendErrorMock.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload.level === 'info')
}

beforeEach(() => {
  mobileShellMock.mockReturnValue(true)
  copyTextMock.mockReset()
  copyTextMock.mockResolvedValue(true)
  logFrontendErrorMock.mockClear()
  toastErrorMock.mockClear()
  resetLongPressFallbackLogForTests()
  useOverlayStackStore.setState({ stack: [] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useOverlayStackStore.setState({ stack: [] })
})

describe('ChatMessage on the mobile shell: focus-revealed row', () => {
  it('makes a user message focusable and hides its row at rest, even when pinned', () => {
    const container = renderMessage(
      <ChatMessage message={userMessage()} onEdit={() => {}} actionsPinned />
    )

    const message = messageElement(container)
    expect(message).toHaveAttribute('tabindex', '0')
    expect(message).toHaveClass(
      'rounded-lg',
      'focus-visible:outline-hidden',
      'focus-visible:-outline-offset-2',
      'focus-visible:ring-2',
      'focus-visible:ring-inset',
      'focus-visible:ring-ring',
      'pointer-coarse:select-none'
    )
    // A bare `outline-none` would leave nothing for forced-colors mode to paint.
    expect(message).not.toHaveClass('outline-none')
    // The trigger owns the long-press, so Radix's iOS callout opt-out applies.
    expect(touchCallout(message)).toBe('none')

    const row = actionsRow()
    expect(row).toHaveClass('opacity-0', 'pointer-events-none')
    expect(row).toHaveClass('group-focus-visible/message:opacity-100')
    expect(row).toHaveClass('focus-within:opacity-100')
    // The bare at-rest `opacity-100` of the touch-visible row is gone.
    expect(row).not.toHaveClass('opacity-100')
    // The row stays mounted and in the accessibility tree.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('makes a settled turn-tail agent message focusable with a hidden row', () => {
    const container = renderMessage(
      <ChatMessage message={agentMessage()} isTurnTail onRetry={() => {}} actionsPinned />
    )

    const message = messageElement(container)
    expect(message).toHaveAttribute('tabindex', '0')
    expect(message).toHaveClass(
      'rounded-lg',
      'focus-visible:outline-hidden',
      'focus-visible:-outline-offset-2',
      'focus-visible:ring-2',
      'focus-visible:ring-inset',
      'focus-visible:ring-ring',
      'pointer-coarse:select-none'
    )
    // A bare `outline-none` would leave nothing for forced-colors mode to paint.
    expect(message).not.toHaveClass('outline-none')
    expect(actionsRow()).toHaveClass('opacity-0', 'pointer-events-none')
    expect(actionsRow()).not.toHaveClass('opacity-100')
  })

  it.each(
    MENU_CASES
  )('does not stop touch pointerdown from bubbling, and cancels its default only for touch or pen ($label)', ({
    ui
  }) => {
    const container = renderMessage(ui())
    const message = messageElement(container)
    const seenAtWindow = vi.fn()
    window.addEventListener('pointerdown', seenAtWindow)
    try {
      // fireEvent returns false when the default was prevented.
      expect(fireEvent.pointerDown(message, { pointerType: 'touch', pointerId: 1 })).toBe(false)
      expect(fireEvent.pointerDown(message, { pointerType: 'pen', pointerId: 2 })).toBe(false)
      expect(fireEvent.pointerDown(message, { pointerType: 'mouse', pointerId: 3 })).toBe(true)
      expect(seenAtWindow).toHaveBeenCalledTimes(3)
    } finally {
      window.removeEventListener('pointerdown', seenAtWindow)
    }
  })
})

describe('ChatMessage on the mobile shell: context menu', () => {
  it('opens Copy and Edit on a user message via the context-menu key', async () => {
    const container = renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)

    expect(await openMenuWithContextMenuKey(messageElement(container))).toEqual(['Copy', 'Edit'])
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  })

  it('opens Copy and Retry on an agent turn tail with onRetry', async () => {
    const container = renderMessage(
      <ChatMessage message={agentMessage()} isTurnTail onRetry={() => {}} />
    )

    expect(await openMenuWithContextMenuKey(messageElement(container))).toEqual(['Copy', 'Retry'])
  })

  it('offers Copy only on a user message the row cannot edit', async () => {
    // No onEdit callback: the row shows Copy only.
    const container = renderMessage(<ChatMessage message={userMessage()} />)

    expect(await openMenuWithContextMenuKey(messageElement(container))).toEqual(['Copy'])
  })

  it('offers Copy only on an agent turn tail without onRetry', async () => {
    const container = renderMessage(<ChatMessage message={agentMessage()} isTurnTail />)

    expect(await openMenuWithContextMenuKey(messageElement(container))).toEqual(['Copy'])
  })

  it('opens on a held touch pointerdown (the 700ms long-press)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const container = renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)

    fireEvent.pointerDown(messageElement(container), { pointerType: 'touch', pointerId: 1 })
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    act(() => {
      vi.advanceTimersByTime(700)
    })

    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Copy', 'Edit'])
  })

  it('does not open from a touch release before 700ms', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const container = renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)
    const message = messageElement(container)

    fireEvent.pointerDown(message, { pointerType: 'touch', pointerId: 1 })
    fireEvent.pointerUp(message, { pointerType: 'touch', pointerId: 1 })
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })

  it.each(
    MENU_CASES
  )('opens only the message menu (no Paste or Select All) inside GlobalContextMenu ($label)', async ({
    ui,
    items: expected
  }) => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const container = renderMessage(ui(), { global: true })

    fireEvent.pointerDown(messageElement(container), { pointerType: 'touch', pointerId: 1 })
    act(() => {
      vi.advanceTimersByTime(700)
    })

    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent?.trim())).toEqual(expected)
    expect(screen.queryByRole('menuitem', { name: /Paste/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Select All/ })).toBeNull()
  })

  it.each(
    MENU_CASES
  )('opens only the message menu on contextmenu inside GlobalContextMenu ($label)', async ({
    ui,
    items: expected
  }) => {
    const container = renderMessage(ui(), { global: true })

    // The message trigger is deeper, so it opens first and cancels the default;
    // the app-level trigger's composed handler then skips.
    expect(await openMenuWithContextMenuKey(messageElement(container))).toEqual(expected)
    expect(screen.queryByRole('menuitem', { name: /Paste/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Select All/ })).toBeNull()
  })

  it('registers with the overlay stack under a per-message id while open', async () => {
    const container = renderMessage(
      <ChatMessage message={userMessage('hi', 'user-42')} onEdit={() => {}} />
    )
    expect(useOverlayStackStore.getState().stack).toHaveLength(0)

    await openMenuWithContextMenuKey(messageElement(container))

    expect(useOverlayStackStore.getState().stack.map((entry) => entry.id)).toEqual([
      `${MENU_PREFIX}user-42`
    ])
    // Opened mid-gesture with the finger still down on its own trigger, so the
    // id must stay exempt from the shell body's `inert`.
    expect(
      useOverlayStackStore.getState().stack.every((entry) => isInertExemptOverlay(entry.id))
    ).toBe(true)
  })

  it('closes on system back and leaves no message entry on the overlay stack', async () => {
    const container = renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)
    await openMenuWithContextMenuKey(messageElement(container))

    let closed = false
    act(() => {
      closed = useOverlayStackStore.getState().closeTopmostOverlay()
    })

    expect(closed).toBe(true)
    await expectMenuClosed()
    expect(
      useOverlayStackStore.getState().stack.some((entry) => entry.id.startsWith(MENU_PREFIX))
    ).toBe(false)
  })

  it('closes on Esc and returns focus to the message', async () => {
    const container = renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)
    const message = messageElement(container)
    message.focus()
    expect(document.activeElement).toBe(message)

    await openMenuWithContextMenuKey(message)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await expectMenuClosed()
    await waitFor(() => expect(document.activeElement).toBe(message))
  })
})

describe('ChatMessage on the mobile shell: menu actions', () => {
  it('Copy copies the display-safe user text, once, and closes the menu', async () => {
    const raw = `${skillToken('review')} please check ${fileToken('a.ts', '/p/a.ts')} ${commandToken('plan')}`
    const display = sanitizeDisplayText(raw)
    expect(display).not.toBe(raw)
    const container = renderMessage(<ChatMessage message={userMessage(raw)} onEdit={() => {}} />)
    await openMenuWithContextMenuKey(messageElement(container))

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))

    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1))
    expect(copyTextMock).toHaveBeenCalledWith(display)
    await expectMenuClosed()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('Copy on an agent tail copies the whole turn text when provided', async () => {
    const container = renderMessage(
      <ChatMessage
        message={agentMessage(false, 'last reply')}
        isTurnTail
        turnText={'first reply\n\nlast reply'}
      />
    )
    await openMenuWithContextMenuKey(messageElement(container))

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))

    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1))
    expect(copyTextMock).toHaveBeenCalledWith('first reply\n\nlast reply')
    await expectMenuClosed()
  })

  it('Edit passes the raw token text to onEdit, once, and leaves focus off the message', async () => {
    const raw = `${skillToken('review')} fix it`
    const onEdit = vi.fn()
    const container = renderMessage(<ChatMessage message={userMessage(raw)} onEdit={onEdit} />)
    const message = messageElement(container)
    message.focus()
    await openMenuWithContextMenuKey(message)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith(raw)
    await expectMenuClosed()
    // Radix would return focus to the message after a tick; Edit opts out so
    // the composer seed keeps focus.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(document.activeElement).not.toBe(message)
  })

  it('returns focus to the message when the menu is closed again after an Edit', async () => {
    const container = renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)
    const message = messageElement(container)
    message.focus()
    await openMenuWithContextMenuKey(message)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await expectMenuClosed()
    // Let Radix's deferred close-focus run (Edit opts out of the focus return).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    // Edit's opt-out must not leak into the next close.
    message.focus()
    await openMenuWithContextMenuKey(message)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await expectMenuClosed()
    await waitFor(() => expect(document.activeElement).toBe(message))
  })

  it('Retry calls onRetry once and closes the menu', async () => {
    const onRetry = vi.fn()
    const container = renderMessage(
      <ChatMessage message={agentMessage()} isTurnTail onRetry={onRetry} />
    )
    await openMenuWithContextMenuKey(messageElement(container))

    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }))

    expect(onRetry).toHaveBeenCalledTimes(1)
    await expectMenuClosed()
  })

  it('a failed Copy closes the menu, shows the existing toast and logs a warn without the text', async () => {
    copyTextMock.mockResolvedValue(false)
    const secret = 'my-private-prompt-text'
    const container = renderMessage(<ChatMessage message={userMessage(secret)} onEdit={() => {}} />)
    await openMenuWithContextMenuKey(messageElement(container))

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Failed to copy'))
    await expectMenuClosed()
    await waitFor(() => expect(logFrontendErrorMock).toHaveBeenCalledTimes(1))
    const payload = logFrontendErrorMock.mock.calls[0][0]
    expect(payload).toMatchObject({ level: 'warn', source: 'MessageActions.contextMenu' })
    expect(JSON.stringify(payload)).not.toContain(secret)
  })

  it('Copy is a silent no-op for a media-only user message', async () => {
    const message: ChatMessageType = {
      id: 'user-media',
      role: 'user',
      blocks: [{ type: 'resource', resource: { uri: 'file:///notes.txt', text: 'attached' } }],
      streaming: false,
      timestamp: 0
    }
    const container = renderMessage(<ChatMessage message={message} onEdit={() => {}} />)

    // No text, so the row (and menu) offer Copy only.
    expect(await openMenuWithContextMenuKey(messageElement(container))).toEqual(['Copy'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))

    await expectMenuClosed()
    expect(copyTextMock).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(logFrontendErrorMock).not.toHaveBeenCalled()
  })
})

describe('ChatMessage on the mobile shell: messages without actions', () => {
  it.each([
    ['streaming agent message', agentMessage(true), { isLast: true, isTurnTail: true }],
    ['settled agent message that is not the turn tail', agentMessage(false), { isTurnTail: false }],
    [
      'settled agent message inside TurnActivity (no tail flag)',
      agentMessage(false),
      { isLast: false }
    ]
  ])('leaves a %s untouched', async (_label, message, props) => {
    const container = renderMessage(<ChatMessage message={message} {...props} onRetry={() => {}} />)
    const el = messageElement(container)

    expect(el).not.toHaveAttribute('tabindex')
    expect(el).not.toHaveClass('pointer-coarse:select-none')
    // The inert wrapper adds no trigger attributes to the message.
    expect(el).not.toHaveAttribute('data-state')
    expect(el).not.toHaveAttribute('data-disabled')
    // ...and does not take the iOS link-preview / save-image callout away.
    expect(touchCallout(el)).not.toBe('none')
    expect(fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 1 })).toBe(true)
    // The default is not prevented, so the app-level / native context menu stays.
    expect(fireEvent.contextMenu(el)).toBe(true)
    await Promise.resolve()
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(logFrontendErrorMock).not.toHaveBeenCalled()
  })
})

describe('ChatMessage on the mobile shell: gaining and losing actions', () => {
  function inTooltipProvider(ui: ReactNode): ReactNode {
    return <TooltipProvider>{ui}</TooltipProvider>
  }

  it('keeps the same message element when a streaming reply settles into the turn tail, and when it stops being the tail', async () => {
    const view = render(
      inTooltipProvider(<ChatMessage message={agentMessage(true)} isLast isTurnTail />)
    )
    const before = messageElement(view.container)
    expect(before).not.toHaveAttribute('tabindex')

    view.rerender(
      inTooltipProvider(
        <ChatMessage message={agentMessage(false)} isLast isTurnTail onRetry={() => {}} />
      )
    )
    expect(messageElement(view.container)).toBe(before)
    expect(before).toHaveAttribute('tabindex', '0')
    expect(await openMenuWithContextMenuKey(before)).toEqual(['Copy', 'Retry'])

    // A later reply takes over the tail while the menu is open: it closes and
    // the message goes back to untouched, on the same element.
    view.rerender(
      inTooltipProvider(<ChatMessage message={agentMessage(false)} isTurnTail={false} />)
    )
    expect(messageElement(view.container)).toBe(before)
    expect(before).not.toHaveAttribute('tabindex')
    expect(before).not.toHaveAttribute('data-state')
    await expectMenuClosed()
  })

  it('does not open from a long-press armed before the message lost its actions', async () => {
    // Pins Radix's behaviour: the trigger clears its pending 700ms timer when
    // `disabled` flips, so an inert message cannot open a stale menu.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const view = render(
      inTooltipProvider(<ChatMessage message={agentMessage(false)} isTurnTail onRetry={() => {}} />)
    )
    fireEvent.pointerDown(messageElement(view.container), { pointerType: 'touch', pointerId: 1 })

    // A later reply takes over the tail before the 700ms elapse.
    view.rerender(
      inTooltipProvider(<ChatMessage message={agentMessage(false)} isTurnTail={false} />)
    )
    act(() => {
      vi.advanceTimersByTime(900)
    })
    await Promise.resolve()

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(useOverlayStackStore.getState().stack).toHaveLength(0)
  })
})

describe('ChatMessage on the mobile shell: portaled descendants', () => {
  const PORTAL_TEXT = 'see the link [portal]'

  it('does not cancel the default of a touch pointerdown that comes from a portaled control', () => {
    const container = renderMessage(
      <ChatMessage message={agentMessage(false, PORTAL_TEXT)} isTurnTail />
    )
    const portaled = screen.getByTestId('portaled-control')
    expect(messageElement(container).contains(portaled)).toBe(false)

    expect(fireEvent.pointerDown(portaled, { pointerType: 'touch', pointerId: 1 })).toBe(true)
    // The message's own content still gets the guard.
    expect(
      fireEvent.pointerDown(screen.getByTestId('streamdown'), {
        pointerType: 'touch',
        pointerId: 2
      })
    ).toBe(false)
  })

  it('does not open the message menu for a long press or right-click on a portaled control', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderMessage(<ChatMessage message={agentMessage(false, PORTAL_TEXT)} isTurnTail />)
    const portaled = screen.getByTestId('portaled-control')

    fireEvent.pointerDown(portaled, { pointerType: 'touch', pointerId: 1 })
    act(() => {
      vi.advanceTimersByTime(900)
    })
    fireEvent.contextMenu(portaled)
    await Promise.resolve()

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(useOverlayStackStore.getState().stack).toHaveLength(0)
  })

  it('does not open the message menu for a context-menu key or right-click on a portaled control, with no pointerdown first', async () => {
    renderMessage(<ChatMessage message={agentMessage(false, PORTAL_TEXT)} isTurnTail />)

    fireEvent.contextMenu(screen.getByTestId('portaled-control'))
    await Promise.resolve()

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(useOverlayStackStore.getState().stack).toHaveLength(0)
  })

  it('still opens the menu for a long press on the message after a portaled press', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const container = renderMessage(
      <ChatMessage message={agentMessage(false, PORTAL_TEXT)} isTurnTail />
    )
    fireEvent.pointerDown(screen.getByTestId('portaled-control'), {
      pointerType: 'touch',
      pointerId: 1
    })
    fireEvent.pointerUp(screen.getByTestId('portaled-control'), {
      pointerType: 'touch',
      pointerId: 1
    })

    fireEvent.pointerDown(messageElement(container), { pointerType: 'touch', pointerId: 2 })
    act(() => {
      vi.advanceTimersByTime(700)
    })

    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Copy'])
  })
})

describe('ChatMessage on the desktop shell', () => {
  beforeEach(() => {
    mobileShellMock.mockReturnValue(false)
  })

  it('keeps a user message exactly as today: no tabindex, no menu, same row classes', async () => {
    const container = renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)
    const message = messageElement(container)

    expect(message).not.toHaveAttribute('tabindex')
    expect(message).not.toHaveAttribute('data-state')
    expect(message.className).not.toMatch(/rounded-lg|focus-visible|select-none/)
    expect(actionsRow().className).toBe(
      'flex items-center gap-2.5 transition-opacity duration-150 focus-within:opacity-100 opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover/message:opacity-100 justify-end -mr-1'
    )
    expect(fireEvent.pointerDown(message, { pointerType: 'touch', pointerId: 1 })).toBe(true)
    fireEvent.contextMenu(message)
    await Promise.resolve()
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })

  it('keeps pinned honoured on a turn-tail agent message', async () => {
    const container = renderMessage(
      <ChatMessage message={agentMessage()} isTurnTail onRetry={() => {}} actionsPinned />
    )
    const message = messageElement(container)

    expect(message).not.toHaveAttribute('tabindex')
    expect(actionsRow().className).toBe(
      'flex items-center gap-2.5 transition-opacity duration-150 focus-within:opacity-100 opacity-100 -ml-1'
    )
    fireEvent.contextMenu(message)
    await Promise.resolve()
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(logFrontendErrorMock).not.toHaveBeenCalled()
  })
})

describe('ChatMessage on the mobile shell without long-press support (fallback)', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', undefined)
  })

  it('shows the row as today (pinned honoured), stays focusable and still opens the menu on contextmenu', async () => {
    const container = renderMessage(
      <ChatMessage message={userMessage()} onEdit={() => {}} actionsPinned />
    )
    const message = messageElement(container)

    const row = actionsRow()
    expect(row.className).toBe(
      'flex items-center gap-2.5 transition-opacity duration-150 focus-within:opacity-100 opacity-100 justify-end -mr-1'
    )
    expect(row).not.toHaveClass('pointer-events-none')
    expect(message).toHaveAttribute('tabindex', '0')
    expect(await openMenuWithContextMenuKey(message)).toEqual(['Copy', 'Edit'])
  })

  it.each(
    MENU_CASES
  )('keeps the focus ring but not the long-press text-selection opt-out ($label)', ({ ui }) => {
    const container = renderMessage(ui())
    const message = messageElement(container)

    expect(message).toHaveClass(
      'rounded-lg',
      'focus-visible:outline-hidden',
      'focus-visible:-outline-offset-2',
      'focus-visible:ring-2'
    )
    expect(message).not.toHaveClass('outline-none')
    expect(message).not.toHaveClass('pointer-coarse:select-none')
  })

  it('keeps the fine-pointer hover behaviour of an unpinned row', () => {
    renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)

    expect(actionsRow()).toHaveClass('opacity-100', 'pointer-fine:opacity-0')
    expect(actionsRow()).not.toHaveClass('opacity-0')
  })

  it('logs one info per page load, however many messages enter the fallback, and never the text', () => {
    renderMessage(
      <>
        <ChatMessage message={userMessage('first-secret-text', 'user-1')} onEdit={() => {}} />
        <ChatMessage message={userMessage('second-secret-text', 'user-2')} onEdit={() => {}} />
        <ChatMessage message={agentMessage(false, 'agent-secret-text')} isTurnTail />
      </>
    )

    const logs = infoLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      level: 'info',
      message: 'long-press unsupported, MessageActions shown'
    })
    expect(JSON.stringify(logs)).not.toMatch(/secret-text/)
  })

  it('does not log the fallback when only messages without actions render', () => {
    renderMessage(<ChatMessage message={agentMessage(true)} isLast />)

    expect(infoLogs()).toHaveLength(0)
  })
})

describe('ChatMessage fallback log outside the fallback', () => {
  it('does not log on the focus-reveal path', () => {
    renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)
    expect(infoLogs()).toHaveLength(0)
  })

  it('does not log on the desktop shell, even without Pointer Events', () => {
    mobileShellMock.mockReturnValue(false)
    vi.stubGlobal('PointerEvent', undefined)
    renderMessage(<ChatMessage message={userMessage()} onEdit={() => {}} />)
    expect(infoLogs()).toHaveLength(0)
  })
})
