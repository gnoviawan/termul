import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '@/lib/acp-api'
import { type ImportableSessions, useAcpStore } from '@/stores/acp-store'
import { CLAUDE_AGENT_CONFIG_ID } from '@/stores/claude-account-switch'
import { ImportChatsDialog } from './ImportChatsDialog'

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  logFrontendError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.logFrontendError }))

const SESSIONS: SessionInfo[] = [
  { sessionId: 's1', cwd: '/work', title: 'Fix the build', updatedAt: '2026-11-01T10:00:00.000Z' },
  { sessionId: 's2', cwd: '/work', title: 'Write the docs', updatedAt: '2026-11-02T10:00:00.000Z' },
  { sessionId: 's3', cwd: '/work', title: null }
]

function seed(listed: ImportableSessions | Promise<ImportableSessions>): {
  list: ReturnType<typeof vi.fn>
  importAll: ReturnType<typeof vi.fn>
} {
  const list = vi.fn(async () => listed)
  const importAll = vi.fn(async ({ sessions }: { sessions: SessionInfo[] }) =>
    sessions.map((s) => ({ sessionId: s.sessionId, status: 'imported' as const }))
  )
  useAcpStore.setState({
    agentConfigs: [
      { id: CLAUDE_AGENT_CONFIG_ID, name: 'Claude', command: 'x', args: [], env: {} }
    ] as never,
    selectedAgentConfigId: null,
    listImportableSessions: list,
    importAgentSessions: importAll
  })
  return { list, importAll }
}

function renderDialog(onOpenChange = vi.fn()) {
  render(<ImportChatsDialog open onOpenChange={onOpenChange} cwd="/work" projectId="p1" />)
  return onOpenChange
}

describe('ImportChatsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists the candidates of the Claude agent for the working copy', async () => {
    const { list } = seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    renderDialog()

    const listbox = await screen.findByRole('listbox', { name: 'Chats to import' })
    expect(within(listbox).getAllByRole('option')).toHaveLength(3)
    expect(within(listbox).getByText('Fix the build')).toBeInTheDocument()
    expect(within(listbox).getByText('Untitled chat')).toBeInTheDocument()
    expect(list).toHaveBeenCalledWith(CLAUDE_AGENT_CONFIG_ID, '/work', 'p1')
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('imports the chats the user picked and closes when all of them came in', async () => {
    const { importAll } = seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    const onOpenChange = renderDialog()

    const options = await screen.findAllByRole('option')
    fireEvent.click(options[0] as HTMLElement)
    fireEvent.click(options[2] as HTMLElement)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('2 of 3 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 chats' }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(importAll).toHaveBeenCalledTimes(1)
    const call = importAll.mock.calls[0]?.[0] as { agentId: string; sessions: SessionInfo[] }
    expect(call.agentId).toBe('agent-1')
    expect(call.sessions.map((s) => s.sessionId)).toEqual(['s1', 's3'])
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Imported 2 chats')
  })

  it('selects every chat with Select all and clears them again', async () => {
    seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    renderDialog()

    await screen.findAllByRole('option')
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('3 of 3 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 3 chats' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.getByText('0 of 3 selected')).toBeInTheDocument()
  })

  it('toggles an option with Space and moves between options with the arrow keys', async () => {
    seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    renderDialog()

    const options = await screen.findAllByRole('option')
    ;(options[0] as HTMLElement).focus()
    fireEvent.keyDown(options[0] as HTMLElement, { key: ' ' })
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(options[0] as HTMLElement, { key: 'ArrowDown' })
    expect(options[1]).toHaveFocus()
  })

  it('keeps the dialog open and names the failure when an import fails', async () => {
    const { importAll } = seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    importAll.mockResolvedValue([{ sessionId: 's1', status: 'failed', message: 'agent exploded' }])
    const onOpenChange = renderDialog()

    fireEvent.click((await screen.findAllByRole('option'))[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 chat' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('1 chat could not be imported')
    expect(screen.getByRole('alert')).toHaveTextContent('agent exploded')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('explains an agent that cannot list its chats', async () => {
    seed({ status: 'unsupported' })
    renderDialog()
    expect(await screen.findByText(/cannot list and load its chats/)).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('says so when every chat is already in the history', async () => {
    seed({ status: 'ready', agentId: 'agent-1', sessions: [] })
    renderDialog()
    expect(await screen.findByText(/No chats to import/)).toBeInTheDocument()
  })

  it('shows the listing error with a retry that lists again', async () => {
    const { list } = seed({ status: 'unsupported' })
    list.mockRejectedValueOnce(new Error('list failed'))
    renderDialog()

    expect(await screen.findByText('list failed')).toBeInTheDocument()
    list.mockResolvedValueOnce({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('asks for an agent when none is configured', async () => {
    seed({ status: 'unsupported' })
    useAcpStore.setState({ agentConfigs: [] })
    renderDialog()
    expect(await screen.findByText(/Configure an agent first/)).toBeInTheDocument()
  })
})
