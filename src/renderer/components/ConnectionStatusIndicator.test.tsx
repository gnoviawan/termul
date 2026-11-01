import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RECONNECT_GRACE_MS } from '@/hooks/use-delayed-flag'

/**
 * Story 10 (F1): StatusBar connection-health indicator — worst-of rollup over
 * the control + terminal channels, reusing AgentConnectionLamp. Hidden on
 * Tauri desktop.
 */

const mockIsTauriContext = vi.hoisted(() => vi.fn(() => false))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: mockIsTauriContext }))

const mockRetryHostOffline = vi.hoisted(() => vi.fn())
vi.mock('@/stores/connection-status-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/connection-status-store')>()),
  retryHostOffline: mockRetryHostOffline
}))

import {
  type ConnectionChannelState,
  useConnectionStatusStore
} from '@/stores/connection-status-store'
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator'

function renderIndicator(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <ConnectionStatusIndicator />
    </TooltipProvider>
  )
}

type ChannelPatch = Partial<Record<'controlChannel' | 'terminalChannel', ConnectionChannelState>>

function setChannels(patch: ChannelPatch): void {
  act(() => {
    useConnectionStatusStore.setState(patch)
  })
  act(() => {
    vi.advanceTimersByTime(RECONNECT_GRACE_MS)
  })
}

function lampClass(): string {
  return document.querySelector('[role="status"] svg')?.getAttribute('class') ?? ''
}

beforeEach(() => {
  vi.useFakeTimers()
  mockIsTauriContext.mockReturnValue(false)
  useConnectionStatusStore.setState({
    controlChannel: 'connected',
    terminalChannel: 'connected'
  })
})

afterEach(() => {
  vi.useRealTimers()
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
    setChannels({ terminalChannel: 'reconnecting' })
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
    setChannels({
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

  it('shows a steady Host offline lamp that wins over worse-looking channels and retries on click', () => {
    useConnectionStatusStore.setState({
      controlChannel: 'host-offline',
      terminalChannel: 'disconnected'
    })
    renderIndicator()
    expect(screen.getByRole('status', { name: 'Host offline' })).toBeInTheDocument()
    expect(lampClass()).not.toContain('animate-pulse')
    expect(lampClass()).not.toContain('text-destructive')
    fireEvent.click(screen.getByRole('button', { name: /select to retry/i }))
    expect(mockRetryHostOffline).toHaveBeenCalledTimes(1)
  })

  it('recovers to a filled lamp when the degraded channel reconnects', () => {
    setChannels({ controlChannel: 'reconnecting' })
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

describe('ConnectionStatusIndicator reconnect grace', () => {
  function setChannel(patch: ChannelPatch): void {
    act(() => {
      useConnectionStatusStore.setState(patch)
    })
  }

  function advance(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  it('keeps the Connected lamp through a 500 ms reconnect', () => {
    renderIndicator()
    const connectedLamp = lampClass()

    setChannel({ controlChannel: 'reconnecting' })
    advance(500)
    expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
    expect(lampClass()).toBe(connectedLamp)

    setChannel({ controlChannel: 'connected' })
    advance(RECONNECT_GRACE_MS * 2)
    expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
    expect(lampClass()).toBe(connectedLamp)
  })

  it('shows the reconnecting lamp once a 2 s outage passes the grace period', () => {
    renderIndicator()

    setChannel({ controlChannel: 'reconnecting' })
    advance(RECONNECT_GRACE_MS - 1)
    expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()

    advance(1)
    expect(
      screen.getByRole('status', { name: 'Control channel: reconnecting' })
    ).toBeInTheDocument()
    expect(lampClass()).toContain('animate-pulse')

    advance(RECONNECT_GRACE_MS)
    setChannel({ controlChannel: 'connected' })
    expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
    expect(lampClass()).not.toContain('animate-pulse')
  })
})
