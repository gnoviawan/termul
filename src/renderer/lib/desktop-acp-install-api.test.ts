import { beforeEach, describe, expect, it, vi } from 'vitest'

const { transport } = vi.hoisted(() => ({
  transport: { installAcpAgent: vi.fn() }
}))

vi.mock('./acp-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acp-transport')>()),
  getAcpTransport: () => transport
}))

import { AcpTransportError } from './acp-transport/types'
import { createDesktopAcpInstallApi } from './desktop-acp-install-api'

describe('createDesktopAcpInstallApi', () => {
  beforeEach(() => {
    transport.installAcpAgent.mockReset()
  })

  it('installAgent sends the agent id and wraps the outcome in a success IpcResult', async () => {
    const outcome = { command: '/path/to/opencode', args: ['acp'] }
    transport.installAcpAgent.mockResolvedValueOnce(outcome)

    const result = await createDesktopAcpInstallApi().installAgent('opencode')

    expect(transport.installAcpAgent).toHaveBeenCalledWith('opencode')
    expect(result).toEqual({ success: true, data: outcome })
  })

  it('installAgent keeps the host install error code', async () => {
    transport.installAcpAgent.mockRejectedValueOnce(
      new AcpTransportError('INTEGRITY_MISMATCH', 'archive checksum does not match')
    )

    const result = await createDesktopAcpInstallApi().installAgent('opencode')

    expect(result).toEqual({
      success: false,
      error: 'archive checksum does not match',
      code: 'INTEGRITY_MISMATCH'
    })
  })

  it('installAgent maps a failure that is not a protocol error to INVOKE_ERROR', async () => {
    transport.installAcpAgent.mockRejectedValueOnce(new Error('channel closed'))

    const result = await createDesktopAcpInstallApi().installAgent('opencode')

    expect(result).toEqual({ success: false, error: 'channel closed', code: 'INVOKE_ERROR' })
  })
})
