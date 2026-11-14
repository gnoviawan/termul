import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BackgroundCommand, ToolCall } from '@/lib/acp-api'
import { subagentToolCall } from '@/lib/test-utils/subagent'
import { useAcpStore } from '@/stores/acp-store'
import type { AcpSession, ChatMessage } from '@/stores/acp-store/types'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { useToolCallRevealStore } from '@/stores/tool-call-reveal-store'
import { ChatStatusChips } from './ChatStatusChips'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

const mobileRef = vi.hoisted(() => ({ current: false }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => mobileRef.current }))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

const NOW = 1_800_000_000_000

const watch: BackgroundCommand = {
  toolCallId: 'exec-watch',
  title: 'Watch PR #1723 checks',
  command: 'gh pr checks 1723 --watch',
  startedAtMs: NOW - 252_000,
  state: 'running'
}

const tests: BackgroundCommand = {
  toolCallId: 'exec-tests',
  title: 'Run host MCP tests',
  command: 'cargo test --lib host_mcp',
  startedAtMs: NOW - 400_000,
  state: 'ended',
  endedAtMs: NOW - 277_000
}

const user: ChatMessage = {
  id: 'u1',
  role: 'user',
  blocks: [],
  streaming: false,
  timestamp: 1,
  seq: 1
}

function seed(
  commands: BackgroundCommand[],
  session: Partial<AcpSession> = {},
  reportedBy = 'agent-1'
): void {
  useAcpStore.setState({
    sessions: {
      s1: {
        id: 's1',
        agentId: 'agent-1',
        status: 'active',
        backgroundCommands: { agentId: reportedBy, revision: 1, commands },
        ...session
      } as unknown as AcpSession
    }
  })
}

function renderPill(toolCalls: ToolCall[] = []): void {
  render(
    <TooltipProvider>
      <ChatStatusChips
        sessionId="s1"
        cwd=""
        toolCalls={toolCalls}
        messages={[user]}
        turnActive={false}
      />
    </TooltipProvider>
  )
}

const pill = () => screen.getByRole('button', { name: /^Background commands:/ })

describe('ChatStatusChips background commands', () => {
  beforeEach(() => {
    mobileRef.current = false
    useOverlayStackStore.setState({ stack: [] })
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    useToolCallRevealStore.setState({ target: null })
  })

  it('counts the commands on the chip and running and ended ones in its panel', () => {
    seed([watch, tests])
    renderPill()
    expect(pill()).toHaveTextContent('Background2')
    expect(pill()).toHaveAccessibleName('Background commands: 1 running, 1 ended')
    expect(pill()).toHaveAttribute('title', '1 command running in the background')
    fireEvent.click(pill())
    expect(
      within(screen.getByRole('dialog', { name: 'Background' })).getByText('1 running, 1 ended')
    ).toBeInTheDocument()
  })

  it('announces and titles a background subagent wait and running commands together', () => {
    seed([watch])
    renderPill([
      subagentToolCall(
        { title: 'Audit code', background: true },
        { toolCallId: 'a1', seq: 2, status: 'completed', timestamp: NOW }
      )
    ])
    const text = 'Waiting on 1 background subagent. 1 command running in the background'
    expect(screen.getByRole('button', { name: /^Subagents:/ })).toHaveAttribute(
      'title',
      'Waiting on 1 background subagent'
    )
    expect(pill()).toHaveAttribute('title', '1 command running in the background')
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(text)
  })

  it('lists each command with its state and elapsed time, and a footnote while one runs', () => {
    seed([watch, tests])
    renderPill()
    fireEvent.click(pill())
    const list = screen.getByRole('dialog', { name: 'Background' })
    expect(within(list).getByRole('button', { name: /^Watch PR #1723 checks/ })).toHaveTextContent(
      'Watch PR #1723 checksgh pr checks 1723 --watchRunning4m 12s'
    )
    expect(within(list).getByRole('button', { name: /^Run host MCP tests/ })).toHaveTextContent(
      'Run host MCP testscargo test --lib host_mcpEnded2m 03s'
    )
    expect(
      within(list).getByText('The agent gets each result when the command ends.')
    ).toBeVisible()

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(within(list).getByRole('button', { name: /^Watch PR/ })).toHaveTextContent('4m 15s')
  })

  it('drops the footnote once every command ended', () => {
    seed([tests])
    renderPill()
    fireEvent.click(pill())
    expect(screen.queryByText('The agent gets each result when the command ends.')).toBeNull()
    expect(pill()).not.toHaveAttribute('title')
  })

  it('closes the list and asks the chat to show the card of a clicked row', () => {
    seed([watch])
    renderPill()
    fireEvent.click(pill())
    fireEvent.click(screen.getByRole('button', { name: /^Watch PR #1723 checks/ }))
    expect(screen.queryByRole('dialog', { name: 'Background' })).toBeNull()
    expect(useToolCallRevealStore.getState().target).toEqual({
      sessionId: 's1',
      toolCallId: 'exec-watch',
      nonce: expect.any(Number)
    })
  })

  it.each([
    ['a closed chat', { status: 'closed' as const }, 'agent-1'],
    ['a list from the agent the chat left', {}, 'agent-old']
  ])('shows no pill for %s', (_, session, reportedBy) => {
    seed([watch], session, reportedBy)
    renderPill()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
