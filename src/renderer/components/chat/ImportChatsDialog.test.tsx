import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionInfo } from '@/lib/acp-api'
import { type ImportableSessions, useAcpStore } from '@/stores/acp-store'
import type { ImportSessionOutcome } from '@/stores/acp-store/types'
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

interface ImportInput {
  sessions: SessionInfo[]
  onProgress?: (done: number, outcome: ImportSessionOutcome) => void
  shouldStop?: () => boolean
}

/** Runs like the store's import: one session at a time, reporting each outcome. */
function fakeImport(
  { sessions, onProgress, shouldStop }: ImportInput,
  outcomeOf: (session: SessionInfo) => ImportSessionOutcome
): ImportSessionOutcome[] {
  const outcomes: ImportSessionOutcome[] = []
  for (const session of sessions) {
    if (shouldStop?.()) break
    const outcome = outcomeOf(session)
    outcomes.push(outcome)
    onProgress?.(outcomes.length, outcome)
  }
  return outcomes
}

function seed(listed: ImportableSessions | Promise<ImportableSessions>): {
  list: ReturnType<typeof vi.fn>
  importAll: ReturnType<typeof vi.fn>
} {
  const list = vi.fn(async () => listed)
  const importAll = vi.fn(async (input: ImportInput) =>
    fakeImport(input, (s) => ({ sessionId: s.sessionId, status: 'imported' }))
  )
  useAcpStore.setState({
    agentConfigs: [
      { id: CLAUDE_AGENT_CONFIG_ID, name: 'Claude Code', command: 'x', args: [], env: {} }
    ] as never,
    selectedAgentConfigId: null,
    listImportableSessions: list,
    importAgentSessions: importAll
  })
  return { list, importAll }
}

/** The footer's own Close (the dialog's corner X shares the name). */
function footerClose(): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: 'Close' })
  return buttons.find((b) => b.textContent === 'Close' && !b.querySelector('svg')) as HTMLElement
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
    expect(screen.getByText('0 selected')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Import chats from Claude Code' })
    ).toBeInTheDocument()
    expect(screen.getByText('3 in this folder')).toBeInTheDocument()
  })

  it('gives a titled chat a short time without a clock', async () => {
    // Midday, so "9 minutes ago" is still today.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 12, 12, 0))
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(14, 10, 0, 0)
    seed({
      status: 'ready',
      agentId: 'agent-1',
      sessions: [
        {
          sessionId: 'recent',
          cwd: '/work',
          title: 'Recent chat',
          updatedAt: new Date(Date.now() - 9 * 60_000 - 5_000).toISOString()
        },
        {
          sessionId: 'older',
          cwd: '/work',
          title: 'Older chat',
          updatedAt: yesterday.toISOString()
        }
      ]
    })
    renderDialog()

    const [recent, older] = await screen.findAllByRole('option')
    expect(recent).toHaveTextContent(/^Recent chat9m ago$/)
    expect(older).toHaveTextContent(/^Older chatYesterday$/)
  })

  it('names an untitled chat by its full time, never by its id', async () => {
    const at = new Date()
    at.setHours(14, 32, 0, 0)
    seed({
      status: 'ready',
      agentId: 'agent-1',
      sessions: [{ sessionId: 'abc123def', cwd: '/work', title: '  ', updatedAt: at.toISOString() }]
    })
    renderDialog()

    const option = await screen.findByRole('option')
    expect(option).toHaveTextContent('Untitled chat')
    expect(option).toHaveTextContent(/^Untitled chatToday, /)
    expect(option).not.toHaveTextContent('abc123')
  })

  it('imports the chats the user picked and closes when all of them came in', async () => {
    const { importAll } = seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    const onOpenChange = renderDialog()

    const options = await screen.findAllByRole('option')
    fireEvent.click(options[0] as HTMLElement)
    fireEvent.click(options[2] as HTMLElement)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 chats' }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(importAll).toHaveBeenCalledTimes(1)
    const call = importAll.mock.calls[0]?.[0] as { agentId: string; sessions: SessionInfo[] }
    expect(call.agentId).toBe('agent-1')
    expect(call.sessions.map((s) => s.sessionId)).toEqual(['s1', 's3'])
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Imported 2 chats')
  })

  it('selects every chat with the select-all checkbox, which shows a partial selection', async () => {
    seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    renderDialog()

    const options = await screen.findAllByRole('option')
    const selectAll = screen.getByRole('checkbox', { name: 'All Claude Code chats' })
    expect(selectAll).not.toBeChecked()

    fireEvent.click(options[1] as HTMLElement)
    expect(selectAll).toBePartiallyChecked()
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    fireEvent.click(selectAll)
    expect(selectAll).toBeChecked()
    expect(screen.getByText('3 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 3 chats' })).toBeEnabled()

    fireEvent.click(selectAll)
    expect(selectAll).not.toBeChecked()
    expect(screen.getByText('0 selected')).toBeInTheDocument()
  })

  it('toggles an option with Space and moves one tab stop with the arrow, Home and End keys', async () => {
    seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    renderDialog()

    const options = (await screen.findAllByRole('option')) as HTMLElement[]
    const tabStops = (): HTMLElement[] => options.filter((o) => o.tabIndex === 0)
    expect(tabStops()).toEqual([options[0]])

    act(() => options[0]?.focus())
    fireEvent.keyDown(options[0] as HTMLElement, { key: ' ' })
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(options[0] as HTMLElement, { key: 'ArrowDown' })
    expect(options[1]).toHaveFocus()
    expect(tabStops()).toEqual([options[1]])
    fireEvent.keyDown(options[1] as HTMLElement, { key: 'End' })
    expect(options[2]).toHaveFocus()
    fireEvent.keyDown(options[2] as HTMLElement, { key: 'Home' })
    expect(options[0]).toHaveFocus()
    fireEvent.keyDown(options[0] as HTMLElement, { key: 'ArrowUp' })
    expect(options[0]).toHaveFocus()
  })

  it('keeps a failed chat selected with a plain reason, logs the code and offers Try again', async () => {
    const { importAll, list } = seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    importAll.mockImplementation(async (input: ImportInput) =>
      fakeImport(input, (s) =>
        s.sessionId === 's2'
          ? {
              sessionId: 's2',
              status: 'failed',
              message: 'ACP_IMPORT_INCOMPLETE: 2 history step(s) could not be recorded'
            }
          : { sessionId: s.sessionId, status: 'imported' }
      )
    )
    const onOpenChange = renderDialog()

    const options = await screen.findAllByRole('option')
    list.mockResolvedValue({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS.slice(1) })
    fireEvent.click(options[0] as HTMLElement)
    fireEvent.click(options[1] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 chats' }))

    const reason = await screen.findByText("Part of this chat's history could not be read.")
    const failedRow = reason.closest('[role="option"]') as HTMLElement
    expect(failedRow).toHaveTextContent('Write the docs')
    expect(failedRow).toHaveAttribute('aria-selected', 'true')
    expect(failedRow).toHaveAccessibleDescription("Part of this chat's history could not be read.")
    expect(screen.queryByText('Fix the build')).not.toBeInTheDocument()
    expect(screen.queryByText(/ACP_IMPORT_INCOMPLETE/)).not.toBeInTheDocument()
    expect(screen.getByText('1 imported, 1 failed')).toBeInTheDocument()
    expect(footerClose()).toBeEnabled()
    expect(mocks.logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('ACP_IMPORT_INCOMPLETE') })
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(importAll).toHaveBeenCalledTimes(2))
    const retry = importAll.mock.calls[1]?.[0] as ImportInput
    expect(retry.sessions.map((s) => s.sessionId)).toEqual(['s2'])
  })

  it('names a timeout plainly', async () => {
    const { importAll } = seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    importAll.mockImplementation(async (input: ImportInput) =>
      fakeImport(input, (s) => ({
        sessionId: s.sessionId,
        status: 'failed',
        message: 'session/load timed out after 90s'
      }))
    )
    renderDialog()

    fireEvent.click((await screen.findAllByRole('option'))[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 chat' }))

    expect(await screen.findByText('The agent took too long to respond.')).toBeInTheDocument()
    expect(screen.queryByText(/timed out after/)).not.toBeInTheDocument()
  })

  it('shows a plain reason on every unfinished chat when the import run itself fails', async () => {
    const { importAll, list } = seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    importAll.mockRejectedValue(new Error('IPC channel closed'))
    const onOpenChange = renderDialog()

    const options = await screen.findAllByRole('option')
    fireEvent.click(options[0] as HTMLElement)
    fireEvent.click(options[2] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 chats' }))

    expect(await screen.findAllByText('This chat could not be imported.')).toHaveLength(2)
    expect(screen.getByText('0 imported, 2 failed')).toBeInTheDocument()
    expect(screen.queryByText(/IPC channel/)).not.toBeInTheDocument()
    expect(mocks.logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('IPC channel closed') })
    )
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('marks each chat as it finishes and stops after the one in flight, Esc included', async () => {
    const { importAll, list } = seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    let input: ImportInput = { sessions: [] }
    let finishFirst: () => void = () => {}
    let finishSecond: () => void = () => {}
    importAll.mockImplementation(
      (given: ImportInput) =>
        new Promise((resolve) => {
          input = given
          const [first, second] = given.sessions as [SessionInfo, SessionInfo]
          finishFirst = () =>
            given.onProgress?.(1, { sessionId: first.sessionId, status: 'imported' })
          finishSecond = () => {
            given.onProgress?.(2, { sessionId: second.sessionId, status: 'imported' })
            resolve([
              { sessionId: first.sessionId, status: 'imported' },
              { sessionId: second.sessionId, status: 'imported' }
            ])
          }
        })
    )
    const onOpenChange = renderDialog()

    await screen.findAllByRole('option')
    fireEvent.click(screen.getByRole('checkbox', { name: 'All Claude Code chats' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import 3 chats' }))

    expect(await screen.findByText('Importing 1 of 3…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Import/ })).not.toBeInTheDocument()
    act(() => finishFirst())
    expect(screen.getByText('Importing 2 of 3…')).toBeInTheDocument()
    expect(
      within(screen.getAllByRole('option')[0] as HTMLElement).getByLabelText('Imported')
    ).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(await screen.findByText('Stopping after this chat…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
    expect(input.shouldStop?.()).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    list.mockResolvedValue({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS.slice(2) })
    await act(async () => finishSecond())
    expect(await screen.findByText('2 imported, 1 skipped')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Import 1 chat' })).toBeEnabled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    fireEvent.click(footerClose())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('stops from the Stop import button', async () => {
    const { importAll } = seed({ status: 'ready', agentId: 'agent-1', sessions: SESSIONS })
    let input: ImportInput = { sessions: [] }
    importAll.mockImplementation(
      (given: ImportInput) =>
        new Promise(() => {
          input = given
        })
    )
    renderDialog()

    fireEvent.click((await screen.findAllByRole('option'))[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 chat' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop import' }))

    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
    expect(input.shouldStop?.()).toBe(true)
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
