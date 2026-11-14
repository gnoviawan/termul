import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { ImportChatsButton } from './ImportChatsButton'

const mocks = vi.hoisted(() => ({ admitted: true }))

vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => mocks.admitted
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

describe('ImportChatsButton', () => {
  beforeEach(() => {
    mocks.admitted = true
    useAcpStore.setState({
      agentConfigs: [],
      listImportableSessions: vi.fn(async () => ({ status: 'unsupported' as const }))
    })
  })

  it('opens the import dialog from the phone row button', () => {
    render(<ImportChatsButton cwd="/work" projectId="p1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Import chats' }))
    expect(screen.getByRole('dialog', { name: 'Import chats' })).toBeInTheDocument()
  })

  it('renders nothing without a working copy', () => {
    render(<ImportChatsButton cwd="  " projectId="p1" />)
    expect(screen.queryByRole('button', { name: 'Import chats' })).not.toBeInTheDocument()
  })

  it('is disabled with the read-only reason when the server refuses remote writes', () => {
    mocks.admitted = false
    render(<ImportChatsButton cwd="/work" projectId="p1" />)
    expect(screen.getByRole('button', { name: 'Import chats' })).toBeDisabled()
    expect(screen.getByText('This server is read-only for remote clients.')).toBeInTheDocument()
  })
})
