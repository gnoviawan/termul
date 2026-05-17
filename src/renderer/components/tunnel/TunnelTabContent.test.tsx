import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TunnelTabContent } from './TunnelTabContent'

vi.mock('@/stores/tunnel-store', () => ({
  useTunnelStore: (selector: (state: { sessions: Array<{ id: string; status: string; publicUrl: string | null; lastError: string | null }>; logs: Array<{ tunnelId: string; line: string; timestamp: number }>; stopTunnel: (id: string) => Promise<{ success: true; data: undefined }> }) => unknown) =>
    selector({
      sessions: [{ id: 't1', status: 'running', publicUrl: 'https://example.com', lastError: null }],
      logs: [],
      stopTunnel: async () => ({ success: true, data: undefined })
    })
}))

describe('TunnelTabContent', () => {
  it('renders public url when session running', () => {
    render(<TunnelTabContent tunnelId="t1" isVisible={true} />)
    expect(screen.getByText('https://example.com')).toBeInTheDocument()
  })
})
