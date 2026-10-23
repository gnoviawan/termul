import type { ConnectionCapabilities } from '@shared/types/web-protocol.types'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { _resetAcpTransportForTests, _setAcpTransportForTests } from '@/lib/acp-transport'
import type { AcpTransport } from '@/lib/acp-transport/types'
import { claudeAccountsApi } from '@/lib/claude-accounts-api'
import { canUseHostSsh } from '@/lib/ssh-api'
import { useHostGate } from './use-host-gate'

function fakeTransport() {
  let granted: ConnectionCapabilities | null = null
  const listeners = new Set<() => void>()
  const transport = {
    connectionCapabilities: () => granted,
    subscribeCapabilities(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sshRequest: async () => undefined,
    dispose() {}
  }
  return {
    transport: transport as unknown as AcpTransport,
    grant(next: ConnectionCapabilities) {
      granted = next
      for (const listener of listeners) listener()
    }
  }
}

function Gates() {
  const accounts = useHostGate(claudeAccountsApi.canManageAccounts)
  const ssh = useHostGate(canUseHostSsh)
  return <span>{`accounts:${accounts} ssh:${ssh}`}</span>
}

afterEach(() => _resetAcpTransportForTests())

describe('useHostGate', () => {
  it('re-renders when the handshake grants or withdraws hostLocal', () => {
    const host = fakeTransport()
    _setAcpTransportForTests(host.transport)
    render(<Gates />)
    expect(screen.getByText('accounts:false ssh:false')).toBeInTheDocument()
    act(() => host.grant({ write: true, hostLocal: true }))
    expect(screen.getByText('accounts:true ssh:true')).toBeInTheDocument()
    act(() => host.grant({ write: true, hostLocal: false }))
    expect(screen.getByText('accounts:false ssh:false')).toBeInTheDocument()
  })
})
