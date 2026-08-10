import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { CustomAcpAgentDialog, exportAgentConfig } from './CustomAcpAgentDialog'

const {
  mockSaveAgentConfig,
  mockToastSuccess,
  mockToastError,
  mockLogFrontendError,
  agentConfigsRef
} = vi.hoisted(() => ({
  mockSaveAgentConfig: vi.fn(async () => {}),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockLogFrontendError: vi.fn(async () => {}),
  // handleSave reads existing configs via getState().agentConfigs to upsert
  // (PATCH 3). Expose a mutable ref the upsert test can seed.
  agentConfigsRef: { current: [] as StoredAgentConfig[] }
}))

vi.mock('@/stores/acp-store', () => {
  const useAcpStore = Object.assign(
    (sel?: (s: { saveAgentConfig: typeof mockSaveAgentConfig }) => unknown) =>
      sel
        ? sel({ saveAgentConfig: mockSaveAgentConfig })
        : { saveAgentConfig: mockSaveAgentConfig },
    { getState: () => ({ agentConfigs: agentConfigsRef.current }) }
  )
  return { useAcpStore }
})

vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

const GOLDEN_PASTE = `{
  "name": "Internal Helper",
  "command": "node",
  "args": ["/path/to/agent.js"],
  "env": { "API_KEY": "$INTERNAL_API_KEY" }
}`

function setTextareaValue(value: string): void {
  const textarea = screen.getByLabelText('Agent config JSON') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value } })
}

async function clickButton(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

async function pasteAndAdvanceToConfirm(paste: string): Promise<void> {
  setTextareaValue(paste)
  await clickButton('Save Agent')
}

describe('CustomAcpAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentConfigsRef.current = []
  })

  it('persists a happy-path paste after the arbitrary-command confirmation', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(GOLDEN_PASTE)
    // Now in the 'confirm' step — the arbitrary-command confirmation.
    expect(screen.getByText(/execute an arbitrary command/i)).toBeInTheDocument()
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
    await clickButton('Confirm — Execute Command')
    await waitFor(() => expect(mockSaveAgentConfig).toHaveBeenCalledTimes(1))
    const stored = mockSaveAgentConfig.mock.calls[0][0] as StoredAgentConfig
    expect(stored.name).toBe('Internal Helper')
    expect(stored.command).toBe('node')
    expect(stored.args).toEqual(['/path/to/agent.js'])
    expect(stored.env).toEqual({ API_KEY: '$INTERNAL_API_KEY' })
    expect(stored.allowTerminal).toBe(false)
    expect(stored.id).toMatch(/^custom-[0-9a-f]{8}$/)
    expect(stored.configId).toBe(stored.id)
    expect(stored.templateId).toBeUndefined()
  })

  it('honors a pasted configId and still generates a fresh id', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(`{
      "configId": "custom-abc12345",
      "name": "H",
      "command": "node",
      "args": [],
      "env": {}
    }`)
    await clickButton('Confirm — Execute Command')
    await waitFor(() => expect(mockSaveAgentConfig).toHaveBeenCalledTimes(1))
    const stored = mockSaveAgentConfig.mock.calls[0][0] as StoredAgentConfig
    expect(stored.configId).toBe('custom-abc12345')
    expect(stored.id).not.toBe('custom-abc12345')
    expect(stored.id).toMatch(/^custom-[0-9a-f]{8}$/)
  })

  it('reuses an existing config id when re-pasting the same configId (upsert, no duplicate)', async () => {
    // PATCH 3: re-pasting exported JSON updates the existing agent instead of
    // creating a duplicate. A config with the same configId is already saved
    // → its id is reused so saveAgentConfig upserts.
    const existing: StoredAgentConfig = {
      id: 'custom-fixedid',
      configId: 'custom-abc12345',
      name: 'Old Name',
      command: 'old',
      args: [],
      env: {},
      allowTerminal: false
    }
    agentConfigsRef.current = [existing]
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(`{
      "configId": "custom-abc12345",
      "name": "New Name",
      "command": "node",
      "args": [],
      "env": {}
    }`)
    await clickButton('Confirm — Execute Command')
    await waitFor(() => expect(mockSaveAgentConfig).toHaveBeenCalledTimes(1))
    const stored = mockSaveAgentConfig.mock.calls[0][0] as StoredAgentConfig
    expect(stored.id).toBe('custom-fixedid')
    expect(stored.configId).toBe('custom-abc12345')
    expect(stored.name).toBe('New Name')
    expect(stored.command).toBe('node')
  })

  it('rejects an unknown field inline and persists nothing', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(`{
      "name": "H",
      "command": "node",
      "args": [],
      "env": {},
      "id": "x"
    }`)
    expect(screen.getByRole('alert').textContent).toContain('Unknown field "id"')
    // Still on the idle (paste) step — no confirm button rendered.
    expect(screen.queryByRole('button', { name: 'Confirm — Execute Command' })).toBeNull()
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('rejects a missing name inline', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(`{ "command": "node", "args": [], "env": {} }`)
    expect(screen.getByRole('alert').textContent).toContain('Name is required')
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('rejects wrong-typed args inline', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(`{ "name": "H", "command": "node", "args": "nope", "env": {} }`)
    expect(screen.getByRole('alert').textContent).toContain('args must be an array')
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('rejects args with non-string elements inline', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(
      `{ "name": "H", "command": "node", "args": [123, "ok"], "env": {} }`
    )
    expect(screen.getByRole('alert').textContent).toContain('args must be an array of strings')
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-only configId inline (no silent fresh id)', async () => {
    // PATCH 7: a whitespace-only configId is rejected rather than silently
    // trimmed to a fresh custom-<uuid8> identity.
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(`{
      "configId": "   ",
      "name": "H",
      "command": "node",
      "args": [],
      "env": {}
    }`)
    expect(screen.getByRole('alert').textContent).toContain(
      'configId cannot be empty or whitespace'
    )
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('rejects a raw secret in env and directs to secure storage', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(`{
      "name": "H",
      "command": "node",
      "args": [],
      "env": { "API_KEY": "sk-ant-xxxxxxxxxxxx" }
    }`)
    const alert = screen.getByRole('alert').textContent ?? ''
    expect(alert).toContain('secure storage')
    expect(alert).toContain('$API_KEY')
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('cancelling the arbitrary-command confirmation prevents persistence', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(GOLDEN_PASTE)
    // Cancel returns to the idle (paste) step — no persistence.
    await clickButton('Cancel')
    expect(screen.queryByRole('button', { name: 'Confirm — Execute Command' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save Agent' })).toBeInTheDocument()
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('allowTerminal:true requires a second confirmation; cancelling it (Back) prevents persistence', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(`{
      "name": "H",
      "command": "node",
      "args": [],
      "env": {},
      "allowTerminal": true
    }`)
    // First confirmation (arbitrary command).
    expect(screen.getByText(/execute an arbitrary command/i)).toBeInTheDocument()
    await clickButton('Confirm — Execute Command')
    // Second confirmation (terminal capability).
    expect(screen.getByText(/ACP terminal capability/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm — Allow Terminal' })).toBeInTheDocument()
    // Back cancels the second confirmation — no persistence.
    await clickButton('Back')
    expect(screen.queryByRole('button', { name: 'Confirm — Allow Terminal' })).toBeNull()
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('allowTerminal:true with both confirmations persists with allowTerminal=true', async () => {
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(`{
      "name": "H",
      "command": "node",
      "args": [],
      "env": {},
      "allowTerminal": true
    }`)
    await clickButton('Confirm — Execute Command')
    await clickButton('Confirm — Allow Terminal')
    await waitFor(() => expect(mockSaveAgentConfig).toHaveBeenCalledTimes(1))
    const stored = mockSaveAgentConfig.mock.calls[0][0] as StoredAgentConfig
    expect(stored.allowTerminal).toBe(true)
  })

  it('exportAgentConfig strips id/templateId, has no trailing newline, and round-trips', async () => {
    const stored: StoredAgentConfig = {
      id: 'custom-abc12345',
      configId: 'custom-abc12345',
      templateId: 'some-template',
      name: 'Internal Helper',
      command: 'node',
      args: ['/path/to/agent.js'],
      env: { API_KEY: '$INTERNAL_API_KEY' },
      allowTerminal: false
    }
    const json = exportAgentConfig(stored)
    // PATCH 8: no trailing newline — byte-identical to the AgentConfig import.
    expect(json.endsWith('\n')).toBe(false)
    const parsed = JSON.parse(json)
    expect(Object.keys(parsed).sort()).toEqual(
      ['allowTerminal', 'args', 'command', 'configId', 'env', 'name'].sort()
    )
    expect(parsed).not.toHaveProperty('id')
    expect(parsed).not.toHaveProperty('templateId')
    expect(parsed.configId).toBe('custom-abc12345')

    // Round-trip: pasting the exported JSON imports cleanly (no unknown
    // fields). configId is honored, fresh id generated (no existing config).
    render(<CustomAcpAgentDialog open={true} onOpenChange={() => {}} />)
    await pasteAndAdvanceToConfirm(json)
    await clickButton('Confirm — Execute Command')
    await waitFor(() => expect(mockSaveAgentConfig).toHaveBeenCalledTimes(1))
    const reimported = mockSaveAgentConfig.mock.calls[0][0] as StoredAgentConfig
    expect(reimported.configId).toBe('custom-abc12345')
    expect(reimported.name).toBe('Internal Helper')
    expect(reimported.allowTerminal).toBe(false)
    expect(reimported.id).toMatch(/^custom-[0-9a-f]{8}$/)
  })

  it('exportAgentConfig throws on a missing/empty configId (corrupt store guard)', async () => {
    // PATCH 9: a corrupt stored config without a configId cannot be exported
    // (would break round-trip). The export surfaces an explicit error.
    const corrupt: StoredAgentConfig = {
      id: 'custom-x',
      configId: undefined,
      name: 'Corrupt',
      command: 'node',
      args: [],
      env: {},
      allowTerminal: false
    }
    expect(() => exportAgentConfig(corrupt)).toThrow(/configId missing/)
  })
})
