import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { McpServersSettings } from './McpServersSettings'

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))

const saveMcpServer = vi.fn(async () => {})
const setMcpServerEnabled = vi.fn(async () => {})
const deleteMcpServer = vi.fn(async () => {})

function seedStore(): void {
  useAcpStore.setState({
    mcpServers: [],
    saveMcpServer,
    setMcpServerEnabled,
    deleteMcpServer
  })
}

describe('McpServersSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedStore()
  })

  it('creates a stdio server and serializes args and environment', async () => {
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Files' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } })
    fireEvent.change(screen.getByLabelText(/arguments/i), { target: { value: '-y\nserver' } })
    fireEvent.change(screen.getByLabelText(/environment/i), {
      target: { value: 'TOKEN=$TOKEN' }
    })
    fireEvent.click(save)
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1))
    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stdio',
        name: 'Files',
        command: 'npx',
        args: ['-y', 'server'],
        env: [{ name: 'TOKEN', value: '$TOKEN' }],
        enabled: true
      })
    )
  })

  it('edits an HTTP server and exposes experimental ACP as disclosure only', async () => {
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'http-1',
          type: 'http',
          name: 'Remote',
          url: 'https://old.test/mcp',
          enabled: true
        }
      ]
    })
    render(<McpServersSettings />)
    expect(screen.getByText(/experimental mcp-over-acp/i)).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /acp/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /edit remote/i }))
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://new.test/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'http-1', type: 'http', url: 'https://new.test/mcp' })
      )
    )
  })

  it('toggles and deletes existing servers', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 'one', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('switch', { name: /disable files/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete files/i }))
    await waitFor(() => expect(setMcpServerEnabled).toHaveBeenCalledWith('one', false))
    expect(deleteMcpServer).toHaveBeenCalledWith('one')
  })

  it('surfaces persistence failures without changing the form contract', async () => {
    saveMcpServer.mockRejectedValueOnce(new Error('disk full'))
    render(<McpServersSettings />)
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Files' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not save/i))
    )
  })
})
