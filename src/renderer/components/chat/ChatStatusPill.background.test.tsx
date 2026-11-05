import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BackgroundCommand } from '@/lib/acp-api'
import { useAcpStore } from '@/stores/acp-store'
import type { AcpSession, ChatMessage } from '@/stores/acp-store/types'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { useToolCallRevealStore } from '@/stores/tool-call-reveal-store'
import { ChatStatusPill } from './ChatStatusPill'

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
        backgroundCommands: { agentId: reportedBy, commands },
        ...session
      } as unknown as AcpSession
    }
  })
}

function renderPill(): void {
  render(
    <TooltipProvider>
      <ChatStatusPill sessionId="s1" cwd="" toolCalls={[]} messages={[user]} turnActive={false} />
    </TooltipProvider>
  )
}

const pill = () => screen.getByRole('button', { name: /^Session status:/ })

describe('ChatStatusPill background commands', () => {
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

  it('counts running and ended commands on the pill', () => {
    seed([watch, tests])
    renderPill()
    expect(pill()).toHaveTextContent('1 running·1 ended')
    expect(pill()).toHaveAccessibleName('Session status: background commands 1 running, 1 ended')
    expect(pill()).toHaveAttribute('title', '1 command running in the background')
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
