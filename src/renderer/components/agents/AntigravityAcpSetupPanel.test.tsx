import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  ANTIGRAVITY_ACP_AGENT,
  ANTIGRAVITY_ACP_RELEASE_TARGETS
} from '@/lib/agents/antigravity-acp'
import { buildSupportedAcpAgents } from '@/lib/agents/supported-acp-agents'
import { AntigravityAcpSetupPanel } from './AntigravityAcpSetupPanel'

const {
  mockDeleteAgentConfig,
  mockIsTauri,
  mockPersistenceRead,
  mockPersistenceWrite,
  mockSaveAgentConfig,
  mockVerifyBinary
} = vi.hoisted(() => ({
  mockDeleteAgentConfig: vi.fn(),
  mockIsTauri: { current: false },
  mockPersistenceRead: vi.fn(),
  mockPersistenceWrite: vi.fn(),
  mockSaveAgentConfig: vi.fn(),
  mockVerifyBinary: vi.fn()
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'windows'),
  arch: vi.fn(() => 'x86_64')
}))

vi.mock('@/lib/api', () => ({
  dialogApi: {
    selectFile: vi.fn()
  },
  openerApi: {
    openUrlWithSystemBrowser: vi.fn()
  },
  persistenceApi: {
    read: mockPersistenceRead,
    write: mockPersistenceWrite
  }
}))

vi.mock('@/lib/acp-api', () => ({
  acpApi: {
    verifyBinary: mockVerifyBinary
  }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => mockIsTauri.current
}))

vi.mock('@/stores/acp-store', () => {
  const useAcpStore = (selector: (state: unknown) => unknown) =>
    selector({
      deleteAgentConfig: mockDeleteAgentConfig,
      saveAgentConfig: mockSaveAgentConfig
    })
  return { useAcpStore }
})

function manualEntry(): ReturnType<typeof buildSupportedAcpAgents>[number] {
  return buildSupportedAcpAgents([], 'windows-x86_64', [ANTIGRAVITY_ACP_AGENT])[0]
}

describe('AntigravityAcpSetupPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.current = false
    mockPersistenceRead.mockResolvedValue({
      success: false,
      code: 'KEY_NOT_FOUND',
      error: 'not found'
    })
    mockPersistenceWrite.mockResolvedValue({ success: true, data: undefined })
    mockSaveAgentConfig.mockResolvedValue(undefined)
    mockDeleteAgentConfig.mockResolvedValue(undefined)
    mockVerifyBinary.mockResolvedValue({
      expectedSha256: ANTIGRAVITY_ACP_RELEASE_TARGETS['windows-x86_64'].sha256,
      actualSha256: ANTIGRAVITY_ACP_RELEASE_TARGETS['windows-x86_64'].sha256,
      matches: true,
      size: 10
    })
  })

  it('requires a manual checksum confirmation in remote web mode', async () => {
    render(<AntigravityAcpSetupPanel entry={manualEntry()} />)

    await waitFor(() => expect(screen.getByText('Manual setup')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Antigravity ACP executable path'), {
      target: { value: '/srv/bin/agy-acp-windows-x64.exe' }
    })
    fireEvent.click(screen.getByLabelText('I understand this account risk.'))

    const saveButton = screen.getByRole('button', { name: 'Save' })
    expect(saveButton).toBeDisabled()
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByLabelText('I verified that the server binary matches the sha-256 value above.')
    )
    fireEvent.click(saveButton)

    await waitFor(() => expect(mockSaveAgentConfig).toHaveBeenCalledTimes(1))
    expect(mockVerifyBinary).not.toHaveBeenCalled()
    expect(mockPersistenceWrite).toHaveBeenCalled()
  })

  it('verifies the selected binary automatically on desktop', async () => {
    mockIsTauri.current = true
    const config: StoredAgentConfig = {
      id: 'acp-registry:antigravity-acp',
      templateId: 'antigravity-acp',
      name: 'Antigravity',
      command: '',
      args: [],
      env: {}
    }
    const onConfigured = vi.fn()

    render(
      <AntigravityAcpSetupPanel entry={{ ...manualEntry(), config }} onConfigured={onConfigured} />
    )

    await waitFor(() => expect(screen.getByText('Antigravity setup')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Antigravity ACP executable path'), {
      target: { value: 'C:/tools/agy-acp-windows-x64.exe' }
    })
    fireEvent.click(screen.getByLabelText('I understand this account risk.'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockVerifyBinary).toHaveBeenCalledTimes(1))
    expect(mockVerifyBinary).toHaveBeenCalledWith(
      'C:/tools/agy-acp-windows-x64.exe',
      ANTIGRAVITY_ACP_RELEASE_TARGETS['windows-x86_64'].sha256
    )
    expect(mockSaveAgentConfig).toHaveBeenCalledTimes(1)
    expect(onConfigured).toHaveBeenCalled()
  })
})
