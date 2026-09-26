import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpSession } from '@/stores/acp-store'
import { useAcpStore } from '@/stores/acp-store'
import { PendingRestartBanner } from './PendingRestartBanner'

type AcpStoreState = ReturnType<typeof useAcpStore.getState>
const mockStartChat = vi.fn(async () => 's-new')

function seedSession(sessionId: string, agentId: string): void {
  const session = { id: sessionId, agentId, cwd: '/work' } as unknown as AcpSession
  useAcpStore.setState({
    sessions: { [sessionId]: session },
    configToLiveAgent: { 'acp-registry:factory-droid\0/work\0': agentId },
    pendingRestartVersions: { 'acp-registry:factory-droid': '0.219.0' }
  })
}

describe('PendingRestartBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAcpStore.setState({
      sessions: {},
      configToLiveAgent: {},
      pendingRestartVersions: {},
      sessionIndex: [],
      startChat: mockStartChat as unknown as AcpStoreState['startChat']
    })
  })

  it('announces the applied version that the live process has not picked up yet', () => {
    seedSession('s1', 'agent-1')

    render(<PendingRestartBanner sessionId="s1" />)

    // Concrete, agent-language copy: the CURRENT chat keeps the old version,
    // and the user's next chat picks the new one up. No "spawn" jargon.
    expect(screen.getByText(/this chat still runs the old version/i)).toBeInTheDocument()
    expect(screen.getByText(/0\.219\.0 applies to your next chat/i)).toBeInTheDocument()
  })

  it('offers a one-click new chat that starts the applied version for the same config', () => {
    seedSession('s1', 'agent-1')

    render(<PendingRestartBanner sessionId="s1" />)

    fireEvent.click(screen.getByRole('button', { name: /open new chat/i }))
    expect(mockStartChat).toHaveBeenCalledWith(
      'acp-registry:factory-droid',
      '/work',
      undefined,
      undefined
    )
  })

  it('renders nothing when the session has no pending restart', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.setState({ pendingRestartVersions: {} })

    const { container } = render(<PendingRestartBanner sessionId="s1" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the live agent belongs to a different config', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.setState({
      configToLiveAgent: { 'acp-registry:other-agent\0/work\0': 'agent-1' }
    })

    const { container } = render(<PendingRestartBanner sessionId="s1" />)

    expect(container).toBeEmptyDOMElement()
  })
})
