import type { SubagentCaps } from '@shared/types/subagent'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { acpStopSubagent, type ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import {
  endedState,
  type SubagentRecordOverrides,
  subagentToolCall
} from '@/lib/test-utils/subagent'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ChatStatusPill } from './ChatStatusPill'
import { SubagentSurfaceProvider } from './SubagentSurface'

const mobileRef = vi.hoisted(() => ({ current: false }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => mobileRef.current }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/acp-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/acp-api')>()),
  acpStopSubagent: vi.fn()
}))
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

const user: ChatMessage = {
  id: 'u1',
  role: 'user',
  blocks: [],
  streaming: false,
  timestamp: 1,
  seq: 1
}

const STOPPABLE: Partial<SubagentCaps> = { stop: 'session-cancel', liveProgress: true }

/** An RFD child session's dispatch card, as the host maps it. */
function child(id: string, record: SubagentRecordOverrides = {}): ToolCall {
  return subagentToolCall(
    {
      id: `child-${id}` as never,
      source: 'acp-rfd',
      title: `Agent ${id}`,
      caps: STOPPABLE,
      ...record
    },
    { toolCallId: `termul-subagent:child-${id}`, seq: 2, timestamp: Date.now() }
  )
}

function Chat({ toolCalls }: { toolCalls: ToolCall[] }): React.JSX.Element {
  return (
    <TooltipProvider>
      <SubagentSurfaceProvider
        sessionId="s1"
        agentId="agent-1"
        toolCalls={toolCalls}
        messages={[user]}
        turnActive
        filePathContext={undefined}
        isVisible
      >
        <ChatStatusPill toolCalls={toolCalls} sessionId="s1" cwd="" messages={[user]} turnActive />
      </SubagentSurfaceProvider>
    </TooltipProvider>
  )
}

const pill = () => screen.getByRole('button', { name: /^Session status:/ })

function openPanel(title: string) {
  fireEvent.click(pill())
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${title}`) }))
  return screen.getByTestId('subagent-panel')
}

describe('Stop one subagent', () => {
  beforeEach(() => {
    mobileRef.current = false
    useOverlayStackStore.setState({ stack: [] })
    vi.mocked(acpStopSubagent).mockReset()
    vi.mocked(toast.error).mockReset()
    vi.mocked(logFrontendError).mockClear()
  })

  it('stops from the panel header at once and waits for the agent to confirm', async () => {
    vi.mocked(acpStopSubagent).mockResolvedValue('sent')
    const { rerender } = render(<Chat toolCalls={[child('1'), child('2')]} />)
    const panel = openPanel('Agent 1')
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop' }))
    expect(acpStopSubagent).toHaveBeenCalledWith('agent-1', 's1', 'child-1')
    const pending = within(panel).getByRole('button', { name: 'Stopping' })
    expect(pending).toBeDisabled()
    await act(async () => {})
    expect(within(panel).getByRole('button', { name: 'Stopping' })).toBeDisabled()

    rerender(
      <Chat
        toolCalls={[
          child('1', { state: endedState('cancelled'), caps: { ...STOPPABLE, stop: null } }),
          child('2')
        ]}
      />
    )
    const stopped = screen.getByTestId('subagent-panel')
    expect(within(stopped).queryByRole('button', { name: /^Stop/ })).toBeNull()
    expect(stopped).toHaveTextContent('Stopped')
  })

  it('shows no Stop when the agent offers none or the subagent ended', () => {
    render(
      <Chat
        toolCalls={[
          child('1', { caps: { stop: null } }),
          child('2', { state: endedState('completed') })
        ]}
      />
    )
    expect(within(openPanel('Agent 1')).queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('surfaces a refused stop as a toast and frees the button', async () => {
    vi.mocked(acpStopSubagent).mockRejectedValue(
      new Error('The agent does not let Troupe stop this subagent')
    )
    render(<Chat toolCalls={[child('1')]} />)
    const panel = openPanel('Agent 1')
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't stop the subagent", {
        description: 'The agent does not let Troupe stop this subagent'
      })
    )
    expect(within(panel).getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'chat.subagentStop' })
    )
  })

  it('asks on the phone before it stops a row, and only that row', async () => {
    mobileRef.current = true
    vi.mocked(acpStopSubagent).mockResolvedValue('sent')
    render(<Chat toolCalls={[child('1'), child('2', { caps: { stop: null } })]} />)
    fireEvent.click(pill())
    const sheet = screen.getByRole('dialog', { name: 'Subagents' })
    expect(within(sheet).queryByRole('button', { name: 'Stop Agent 2' })).toBeNull()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Stop Agent 1' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Stop agent?' })
    expect(confirm).toHaveTextContent('Its work so far is kept.')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(acpStopSubagent).not.toHaveBeenCalled()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Stop Agent 1' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop' })
    )
    expect(acpStopSubagent).toHaveBeenCalledWith('agent-1', 's1', 'child-1')
    expect(screen.getByRole('dialog', { name: 'Subagents' })).toBeInTheDocument()
  })
})
