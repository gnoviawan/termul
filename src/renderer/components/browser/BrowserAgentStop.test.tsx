/**
 * The agent-control indicator with Stop: visible while an agent drives a
 * browser tab for the session, Stop goes to the host through the facade,
 * and the stopped state reads from the host's `browser_stop_changed`.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockStop, mockToastError } = vi.hoisted(() => ({
  mockStop: vi.fn(),
  mockToastError: vi.fn()
}))

vi.mock('@/lib/browser-consent-api', () => ({ stopBrowserAgent: mockStop }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

import { useBrowserControlStore } from '@/stores/browser-control-store'
import { BrowserAgentIndicator, BrowserAgentTabStop } from './BrowserAgentStop'

beforeEach(() => {
  mockStop.mockReset().mockResolvedValue(true)
  mockToastError.mockReset()
  useBrowserControlStore.setState({ tabSessions: {}, stoppedSessions: {} })
})

afterEach(() => cleanup())

describe('BrowserAgentIndicator', () => {
  it('renders nothing while no agent tab belongs to the session', () => {
    useBrowserControlStore.setState({ tabSessions: { 'agent-1': 'other' } })
    const { container } = render(<BrowserAgentIndicator sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers Stop while the agent drives a tab, and sends it for the session', async () => {
    useBrowserControlStore.setState({ tabSessions: { 'agent-1': 's1' } })
    render(<BrowserAgentIndicator sessionId="s1" />)
    expect(screen.getByRole('status')).toHaveTextContent('The agent is using the browser.')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop agent browsing' }))
    })
    expect(mockStop).toHaveBeenCalledWith('s1')
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('shows the stopped state from the host instead of the button', () => {
    useBrowserControlStore.setState({
      tabSessions: { 'agent-1': 's1' },
      stoppedSessions: { s1: true }
    })
    render(<BrowserAgentIndicator sessionId="s1" />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Browsing stopped until your next message.'
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('tells the user when the host did not take the Stop', async () => {
    mockStop.mockResolvedValue(false)
    useBrowserControlStore.setState({ tabSessions: { 'agent-1': 's1' } })
    render(<BrowserAgentIndicator sessionId="s1" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop agent browsing' }))
    })
    expect(mockToastError).toHaveBeenCalledWith('Could not stop the agent browser. Try again.')
  })
})

describe('BrowserAgentTabStop', () => {
  it('stops the owning session without selecting the tab', async () => {
    const onSelect = vi.fn()
    render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: stands in for the tab chrome's click target
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the tab chrome's click target
      <div onClick={onSelect}>
        <BrowserAgentTabStop sessionId="s1" />
      </div>
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('browser-agent-tab-stop'))
    })
    expect(mockStop).toHaveBeenCalledWith('s1')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('hides once the session is stopped', () => {
    useBrowserControlStore.setState({ stoppedSessions: { s1: true } })
    const { container } = render(<BrowserAgentTabStop sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })
})
