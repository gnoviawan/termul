import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import {
  endedState,
  type SubagentRecordOverrides,
  subagentToolCall
} from '@/lib/test-utils/subagent'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ChatStatusChips } from './ChatStatusChips'
import { SubagentSurfaceProvider } from './SubagentSurface'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

const mobileRef = vi.hoisted(() => ({ current: false }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => mobileRef.current }))

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

/** A Claude dispatch whose record follows its call status, as the host maps it. */
function sub(partial: Partial<ToolCall>, record: SubagentRecordOverrides = {}): ToolCall {
  const { status } = partial
  const settled = record.background
    ? status === 'failed'
    : status === 'completed' || status === 'failed'
  return subagentToolCall(
    {
      title: 'Audit code',
      prompt: 'do it',
      role: 'general-purpose',
      ...(settled && status && { state: endedState(status === 'failed' ? 'failed' : 'completed') }),
      ...record
    },
    { toolCallId: 'a1', seq: 2, timestamp: Date.now(), ...partial }
  )
}

/** No cwd: no git status read and, without file edits, no changed files. */
const base = {
  sessionId: 's1',
  cwd: '',
  messages: [user] as readonly ChatMessage[],
  turnActive: true
}

type PillProps = Partial<typeof base> & { hidden?: boolean; isVisible?: boolean }

/** The pill inside its chat's subagent surface, as AgentChatPanel mounts it. */
function Pill({ toolCalls, ...extra }: PillProps & { toolCalls: ToolCall[] }): React.JSX.Element {
  const props = { ...base, ...extra }
  return (
    <TooltipProvider>
      <SubagentSurfaceProvider
        sessionId={props.sessionId}
        agentId={undefined}
        toolCalls={toolCalls}
        messages={props.messages}
        turnActive={props.turnActive}
        filePathContext={undefined}
        isVisible={props.isVisible ?? true}
      >
        <ChatStatusChips toolCalls={toolCalls} {...props} />
      </SubagentSurfaceProvider>
    </TooltipProvider>
  )
}

function renderPill(toolCalls: ToolCall[], extra: PillProps = {}) {
  return render(<Pill toolCalls={toolCalls} {...extra} />)
}

const panel = () => screen.getByTestId('subagent-panel')

const pill = () => screen.getByRole('button', { name: /^Subagents:/ })

describe('ChatStatusChips subagents', () => {
  beforeEach(() => {
    mobileRef.current = false
    useOverlayStackStore.setState({ stack: [] })
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders no chip without current-turn subagents or while hidden', () => {
    renderPill([
      sub({ seq: 0 }),
      { toolCallId: 'r', kind: 'read', rawInput: { path: 'a' }, seq: 3 }
    ])
    expect(screen.queryByRole('button')).toBeNull()
    renderPill([sub({})], { hidden: true })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the count on the chip, and the summary and rows in its panel', () => {
    renderPill([
      sub({ toolCallId: 'a', status: 'in_progress' }),
      sub(
        { toolCallId: 'b', status: 'completed' },
        { title: 'Write tests', role: undefined, usage: { durationMs: 3574, totalTokens: 37847 } }
      ),
      sub({ toolCallId: 'c', status: 'failed' })
    ])
    expect(pill()).toHaveTextContent('Subagent3')
    expect(pill()).toHaveAccessibleName('Subagents: 1 working, 1 done, 1 failed')
    fireEvent.click(pill())
    const popover = screen.getByRole('dialog', { name: 'Subagents' })
    expect(popover).not.toHaveAttribute('data-sheet')
    expect(within(popover).getByText('1 working, 1 done, 1 failed')).toBeInTheDocument()
    expect(within(popover).getByRole('button', { name: /^Write tests.*Done/ })).toHaveTextContent(
      /Done\s*3s/
    )
    expect(within(popover).getByRole('button', { name: /^Audit code.*Working/ })).toBeVisible()
    expect(within(popover).getAllByText('general-purpose').length).toBeGreaterThan(0)
  })

  it('opens the subagent panel from a row and closes the popover', () => {
    renderPill([sub({ status: 'completed' }), sub({ toolCallId: 'b', status: 'in_progress' })])
    fireEvent.click(pill())
    fireEvent.click(screen.getByRole('button', { name: /^Audit code.*Done/ }))
    expect(screen.queryByRole('dialog', { name: 'Subagents' })).toBeNull()
    expect(panel()).toHaveTextContent('Subagent of this chat · 1 of 2')
    expect(within(panel()).getByRole('heading', { name: 'Audit code' })).toBeInTheDocument()
  })

  it('ticks only while open and visible, and keeps the settled duration', () => {
    const start = Date.now()
    const running = sub({ status: 'in_progress', timestamp: start })
    const { rerender } = renderPill([running])
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(vi.getTimerCount()).toBe(0)

    fireEvent.click(pill())
    const row = () => screen.getByRole('button', { name: /^Audit code.*Working/ })
    expect(row()).toHaveTextContent(/Working\s*4s/)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(row()).toHaveTextContent(/Working\s*7s/)

    rerender(<Pill toolCalls={[running]} isVisible={false} />)
    // Hiding also closes the popover; drain Radix's unmount focus timers (a
    // live tick interval would make runAllTimers abort instead).
    act(() => {
      vi.runAllTimers()
    })
    expect(vi.getTimerCount()).toBe(0)

    const settled = sub({ status: 'completed', timestamp: start }, { endedAt: start + 7000 })
    rerender(<Pill toolCalls={[settled]} turnActive={false} />)
    fireEvent.click(pill())
    const done = () => screen.getByRole('button', { name: /^Audit code.*Done/ })
    expect(done()).toHaveTextContent(/Done\s*7s/)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(done()).toHaveTextContent(/Done\s*7s/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes the popover when its chat tab is hidden', () => {
    const calls = [sub({ status: 'completed' })]
    const { rerender } = renderPill(calls)
    fireEvent.click(pill())
    expect(screen.getByRole('dialog', { name: 'Subagents' })).toBeInTheDocument()

    rerender(<Pill toolCalls={calls} isVisible={false} />)
    expect(screen.queryByRole('dialog', { name: 'Subagents' })).toBeNull()

    rerender(<Pill toolCalls={calls} />)
    expect(screen.queryByRole('dialog', { name: 'Subagents' })).toBeNull()
  })

  it('shows an in-flight call as stopped once the turn ended', () => {
    renderPill([sub({ status: 'in_progress' })], { turnActive: false })
    fireEvent.click(pill())
    expect(screen.getByText('1 stopped')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Audit code.*Stopped/ })).toBeInTheDocument()
  })

  it('keeps the panel open when its subagent leaves the current turn', () => {
    const call = sub({ status: 'completed' })
    const { rerender } = renderPill([call], { turnActive: false })
    fireEvent.click(pill())
    fireEvent.click(screen.getByRole('button', { name: /^Audit code.*Done/ }))
    rerender(
      <Pill
        toolCalls={[call]}
        turnActive={false}
        messages={[user, { ...user, id: 'u2', seq: 10 }]}
      />
    )
    expect(within(panel()).getByRole('heading', { name: 'Audit code' })).toBeInTheDocument()
  })

  it('counts a launched background agent as running and tags its row', () => {
    const launched = sub(
      { status: 'completed' },
      { background: true, outputFile: '/tmp/a1.output' }
    )
    renderPill([launched])
    expect(pill()).toHaveAccessibleName('Subagents: 1 working')
    fireEvent.click(pill())
    const row = screen.getByRole('button', { name: /^Audit code.*Working/ })
    expect(within(row).getByText('background')).toBeInTheDocument()
    fireEvent.click(row)
    expect(within(panel()).getByText('Working')).toBeInTheDocument()
    expect(within(panel()).getByText('Output file: /tmp/a1.output')).toBeInTheDocument()
  })

  it('says the chat waits on background subagents after the turn ends, and logs it once', () => {
    vi.mocked(logFrontendError).mockClear()
    const launched = sub({ status: 'completed' }, { background: true })
    const done = sub({ toolCallId: 'b', status: 'completed' })
    const { rerender } = renderPill([launched, done], { turnActive: false })
    expect(pill()).toHaveAccessibleName(
      'Subagents: 1 working, 1 done; waiting on 1 background subagent'
    )
    fireEvent.click(pill())
    const popover = screen.getByRole('dialog', { name: 'Subagents' })
    expect(within(popover).getByText('Waiting on 1 background subagent')).toBeInTheDocument()

    const ended = sub({ status: 'completed' }, { background: true, state: endedState() })
    rerender(<Pill toolCalls={[ended, done]} turnActive={false} />)
    expect(pill()).toHaveAccessibleName('Subagents: 2 done')
    expect(screen.queryByText(/^Waiting on/)).toBeNull()
    expect(
      vi
        .mocked(logFrontendError)
        .mock.calls.map(([entry]) => entry.message)
        .filter((message) => message.includes('background'))
    ).toEqual([
      'Chat s1 waits on 1 background subagent after its turn ended',
      'Chat s1 no longer waits on background subagents'
    ])
  })

  it('lists an earlier turn subagent the host still runs, so the wait has a row', () => {
    const earlier = sub(
      { seq: 0, status: 'completed' },
      { background: true, source: 'acp-rfd', caps: { liveProgress: true } }
    )
    renderPill([earlier], { turnActive: false })
    expect(pill()).toHaveAccessibleName('Subagents: 1 working; waiting on 1 background subagent')
    fireEvent.click(pill())
    const popover = screen.getByRole('dialog', { name: 'Subagents' })
    expect(within(popover).getByText('Waiting on 1 background subagent')).toBeInTheDocument()
    expect(within(popover).getAllByRole('button', { name: /Audit code/ })).toHaveLength(1)
    expect(within(popover).getByRole('button', { name: /^Audit code.*Working/ })).toBeVisible()
  })

  it('does not say it waits while the turn is still running', () => {
    const launched = sub({ status: 'completed' }, { background: true })
    renderPill([launched])
    expect(pill()).toHaveAccessibleName('Subagents: 1 working')
  })

  it('opens a bottom sheet on the phone shell and registers it for Back', () => {
    mobileRef.current = true
    renderPill([sub({ status: 'completed' }), sub({ toolCallId: 'b', status: 'in_progress' })])
    expect(pill()).toHaveTextContent('Subagent2')
    fireEvent.click(pill())
    const sheet = screen.getByRole('dialog', { name: 'Subagents' })
    expect(sheet).toHaveAttribute('data-sheet')
    expect(useOverlayStackStore.getState().stack.map((e) => e.id)).toEqual(['chat-status-sheet'])
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    expect(useOverlayStackStore.getState().stack).toEqual([])
  })
})
