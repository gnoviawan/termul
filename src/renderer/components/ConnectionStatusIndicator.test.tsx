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

  it('shows a green Connected lamp when both channels are connected', () => {
    renderIndicator()
    expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
    expect(lampClass()).toContain('text-connection')
  })

  it('shows amber pulse + names the channel when the terminal channel is reconnecting', () => {
    useConnectionStatusStore.setState({ terminalChannel: 'reconnecting' })
    renderIndicator()
    expect(
      screen.getByRole('status', { name: 'Terminal channel: reconnecting' })
    ).toBeInTheDocument()
    expect(lampClass()).toContain('text-warning')
    expect(lampClass()).toContain('animate-pulse')
  })

  it('shows amber during the initial control-channel connect (boot with /ws slow)', () => {
    useConnectionStatusStore.setState({ controlChannel: 'connecting' })
    renderIndicator()
    expect(screen.getByRole('status', { name: 'Control channel: connecting' })).toBeInTheDocument()
    expect(lampClass()).toContain('text-warning')
  })

  it('rolls up worst-of channels: disconnected wins over reconnecting', () => {
    useConnectionStatusStore.setState({
      controlChannel: 'reconnecting',
      terminalChannel: 'disconnected'
    })
    renderIndicator()
    // The tooltip/label names BOTH degraded channels; the lamp is red (worst).
    expect(
      screen.getByRole('status', {
        name: 'Control channel: reconnecting; Terminal channel: disconnected'
      })
    ).toBeInTheDocument()
    expect(lampClass()).toContain('text-destructive')
  })

  it('recovers to green when the degraded channel reconnects', () => {
    useConnectionStatusStore.setState({ controlChannel: 'reconnecting' })
    const { rerender } = render(
      <TooltipProvider>
        <ConnectionStatusIndicator />
      </TooltipProvider>
    )
    expect(lampClass()).toContain('text-warning')

    useConnectionStatusStore.setState({ controlChannel: 'connected' })
    rerender(
      <TooltipProvider>
        <ConnectionStatusIndicator />
      </TooltipProvider>
    )
    expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
    expect(lampClass()).toContain('text-connection')
  })
})
