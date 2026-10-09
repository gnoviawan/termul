import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * Story 10 (F1): StatusBar connection-health indicator — worst-of rollup over
 * the control + terminal channels, reusing AgentConnectionLamp. Hidden on
 * Tauri desktop.
 */

const mockIsTauriContext = vi.hoisted(() => vi.fn(() => false))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: mockIsTauriContext }))

import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator'

function renderIndicator(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <ConnectionStatusIndicator />
    </TooltipProvider>
  )
}

function lampClass(): string {
  return document.querySelector('[role="status"] svg')?.getAttribute('class') ?? ''
}

beforeEach(() => {
  mockIsTauriContext.mockReturnValue(false)
  useConnectionStatusStore.setState({
    controlChannel: 'connected',
    terminalChannel: 'connected'
  })
})

describe('ConnectionStatusIndicator', () => {
  it('renders nothing on Tauri desktop', () => {
    mockIsTauriContext.mockReturnValue(true)
    const { container } = renderIndicator()
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('gives the trigger a 44px border box on coarse pointers only (#881)', () => {
    renderIndicator()
    const button = screen.getByRole('button', { name: 'Connected' })
    // The element's own box is what layout measurement sees (a ::after slop
    // does not change getBoundingClientRect). A fine pointer, including a
    // narrow desktop window, stays a 24px slot.
    expect(button.className).toContain('size-6')
    expect(button.className).not.toContain('max-md:')
    expect(button.className).toContain('pointer-coarse:size-11')
    expect(button.className).toContain('pointer-coarse:-my-2.5')
    expect(button.className).toContain('pointer-coarse:-translate-y-2.5')
    expect(button.className).toContain('pointer-coarse:after:inset-0')
    expect(button.querySelector('span')?.className).toContain('pointer-coarse:translate-y-2.5')
    expect(button.querySelector('span')?.className).not.toContain('max-md:')
  })

  it('shows a filled Connected lamp when both channels are connected', () => {
    renderIndicator()
    expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
    // Quiet bar (card surface): the lamp uses the status tone.
    expect(lampClass()).toContain('text-connection')
    expect(lampClass()).toContain('fill-current')
  })

  it('shows pulse + names the channel when the terminal channel is reconnecting', () => {
    useConnectionStatusStore.setState({ terminalChannel: 'reconnecting' })
    renderIndicator()
    expect(
      screen.getByRole('status', { name: 'Terminal channel: reconnecting' })
    ).toBeInTheDocument()
    expect(lampClass()).toContain('text-warning')
    expect(lampClass()).toContain('animate-pulse')
  })

  it('shows pulse during the initial control-channel connect (boot with /ws slow)', () => {
    useConnectionStatusStore.setState({ controlChannel: 'connecting' })
    renderIndicator()
    expect(screen.getByRole('status', { name: 'Control channel: connecting' })).toBeInTheDocument()
    expect(lampClass()).toContain('animate-pulse')
  })

  it('rolls up worst-of channels: disconnected wins over reconnecting', () => {
    useConnectionStatusStore.setState({
      controlChannel: 'reconnecting',
      terminalChannel: 'disconnected'
    })
    renderIndicator()
    // The tooltip/label names BOTH degraded channels; the lamp shows the worst.
    expect(
      screen.getByRole('status', {
        name: 'Control channel: reconnecting; Terminal channel: disconnected'
      })
    ).toBeInTheDocument()
    expect(lampClass()).toContain('text-destructive')
  })

  it('recovers to a filled lamp when the degraded channel reconnects', () => {
    useConnectionStatusStore.setState({ controlChannel: 'reconnecting' })
    const { rerender } = render(
      <TooltipProvider>
        <ConnectionStatusIndicator />
      </TooltipProvider>
    )
    expect(lampClass()).toContain('animate-pulse')

    useConnectionStatusStore.setState({ controlChannel: 'connected' })
    rerender(
      <TooltipProvider>
        <ConnectionStatusIndicator />
      </TooltipProvider>
    )
    expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
    expect(lampClass()).toContain('fill-current')
    expect(lampClass()).not.toContain('animate-pulse')
  })
})

describe('ConnectionStatusIndicator labelled status mode', () => {
  function renderLabelled(): ReturnType<typeof render> {
    return render(
      <TooltipProvider>
        <ConnectionStatusIndicator showLabel />
      </TooltipProvider>
    )
  }

  it('keeps the default render unchanged when the new props are omitted', () => {
    const plain = renderIndicator()
    const plainHtml = plain.container.innerHTML
    plain.unmount()

    const explicit = render(
      <TooltipProvider>
        <ConnectionStatusIndicator showLabel={false} />
      </TooltipProvider>
    )
    expect(explicit.container.innerHTML).toBe(plainHtml)
    // Still the tooltip-trigger button with the summary as its aria-label.
    expect(screen.getByRole('button', { name: 'Connected' })).toBeInTheDocument()
    expect(lampClass()).toContain('text-connection')
  })

  it('shows the summary as visible text content of the status region', () => {
    renderLabelled()

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Connected')
    expect(status).toHaveAttribute('aria-live', 'polite')
    // The state is the text, not a changing aria-label.
    expect(status).not.toHaveAttribute('aria-label')
    const label = screen.getByText('Connected')
    expect(label).toHaveClass('min-w-0')
    expect(status).toHaveClass('text-2xs', 'text-muted-foreground')
  })

  it('has no tooltip button and a decorative lamp', () => {
    renderLabelled()

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    const lamp = document.querySelector('[role="status"] svg')
    expect(lamp).toHaveAttribute('aria-hidden', 'true')
    expect(lamp).not.toHaveAttribute('aria-label')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('uses the connection lamp colour when connected', () => {
    renderLabelled()

    expect(lampClass()).toContain('text-connection')
    expect(lampClass()).toContain('fill-current')
  })

  it('names the degraded channel and warns while it reconnects', () => {
    useConnectionStatusStore.setState({ controlChannel: 'reconnecting' })
    renderLabelled()

    expect(screen.getByRole('status')).toHaveTextContent('Control channel: reconnecting')
    expect(lampClass()).toContain('text-warning')
    expect(lampClass()).toContain('animate-pulse')
    expect(lampClass()).toContain('motion-reduce:animate-none')
  })

  it('rolls both degraded channels into the text and turns destructive when disconnected', () => {
    useConnectionStatusStore.setState({
      controlChannel: 'reconnecting',
      terminalChannel: 'disconnected'
    })
    renderLabelled()

    expect(screen.getByRole('status')).toHaveTextContent(
      'Control channel: reconnecting; Terminal channel: disconnected'
    )
    expect(lampClass()).toContain('text-destructive')
  })

  it('renders nothing on Tauri desktop', () => {
    mockIsTauriContext.mockReturnValue(true)
    const { container } = renderLabelled()
    expect(container).toBeEmptyDOMElement()
  })
})
