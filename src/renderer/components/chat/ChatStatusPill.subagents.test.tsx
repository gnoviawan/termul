import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ChatStatusPill } from './ChatStatusPill'

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

function sub(partial: Partial<ToolCall>): ToolCall {
  return {
    toolCallId: 'a1',
    seq: 2,
    timestamp: Date.now(),
    rawInput: {
      description: 'Audit code',
      prompt: 'do it',
      subagent_type: 'general-purpose'
    },
    ...partial
  }
}

/** No cwd: no git status read and, without file edits, no changed files. */
const base = {
  sessionId: 's1',
  cwd: '',
  messages: [user],
  turnActive: true,
  filePathContext: undefined
}

function renderPill(
  toolCalls: ToolCall[],
  extra: Partial<typeof base> & { hidden?: boolean } = {}
) {
  return render(<ChatStatusPill toolCalls={toolCalls} {...base} {...extra} />)
}

const pill = () => screen.getByRole('button', { name: /^Session status:/ })

describe('ChatStatusPill subagents', () => {
  beforeEach(() => {
    mobileRef.current = false
    useOverlayStackStore.setState({ stack: [] })
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders no pill without current-turn subagents or while hidden', () => {
    renderPill([
      sub({ seq: 0 }),
      { toolCallId: 'r', kind: 'read', rawInput: { path: 'a' }, seq: 3 }
    ])
    expect(screen.queryByRole('button')).toBeNull()
    renderPill([sub({})], { hidden: true })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows counts on the pill and rows in the popover', () => {
    renderPill([
      sub({ toolCallId: 'a', status: 'in_progress' }),
      sub({
        toolCallId: 'b',
        status: 'completed',
        rawInput: { description: 'Write tests', prompt: 'p' },
        subagentUsage: { totalDurationMs: 3574, totalTokens: 37847 }
      }),
      sub({ toolCallId: 'c', status: 'failed' })
    ])
    expect(pill()).toHaveTextContent(/1 running.*1 done.*1 failed/)
    expect(pill()).toHaveAccessibleName('Session status: subagents 1 running, 1 done, 1 failed')
    fireEvent.click(pill())
    const popover = screen.getByRole('dialog', { name: 'Subagents' })
    expect(popover).not.toHaveAttribute('data-sheet')
    expect(within(popover).getByRole('button', { name: /^done\s*Write tests/ })).toHaveTextContent(
      /00:03.*37\.8k tok/
    )
    expect(within(popover).getAllByText('general-purpose').length).toBeGreaterThan(0)
  })

  it('opens the details dialog from a row and closes the popover', () => {
    renderPill([sub({ status: 'completed' })])
    fireEvent.click(pill())
    fireEvent.click(screen.getByRole('button', { name: /^done\s*Audit code/ }))
    expect(screen.queryByRole('dialog', { name: 'Subagents' })).toBeNull()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
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
    const row = () => screen.getByRole('button', { name: /^running\s*Audit code/ })
    expect(row()).toHaveTextContent('00:04')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(row()).toHaveTextContent('00:07')

    rerender(<ChatStatusPill toolCalls={[running]} {...base} isVisible={false} />)
    // Hiding also closes the popover; drain Radix's unmount focus timers (a
    // live tick interval would make runAllTimers abort instead).
    act(() => {
      vi.runAllTimers()
    })
    expect(vi.getTimerCount()).toBe(0)

    rerender(
      <ChatStatusPill
        toolCalls={[{ ...running, status: 'completed' }]}
        {...base}
        turnActive={false}
      />
    )
    fireEvent.click(pill())
    const done = () => screen.getByRole('button', { name: /^done\s*Audit code/ })
    expect(done()).toHaveTextContent('00:07')
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(done()).toHaveTextContent('00:07')
  })

  it('closes the popover when its chat tab is hidden', () => {
    const calls = [sub({ status: 'completed' })]
    const { rerender } = renderPill(calls)
    fireEvent.click(pill())
    expect(screen.getByRole('dialog', { name: 'Subagents' })).toBeInTheDocument()

    rerender(<ChatStatusPill toolCalls={calls} {...base} isVisible={false} />)
    expect(screen.queryByRole('dialog', { name: 'Subagents' })).toBeNull()

    rerender(<ChatStatusPill toolCalls={calls} {...base} />)
    expect(screen.queryByRole('dialog', { name: 'Subagents' })).toBeNull()
  })

  it('shows an in-flight call as stopped (counted failed) once the turn ended', () => {
    renderPill([sub({ status: 'in_progress' })], { turnActive: false })
    expect(pill()).toHaveTextContent('1 failed')
    fireEvent.click(pill())
    expect(screen.getByRole('button', { name: /^stopped\s*Audit code/ })).toBeInTheDocument()
  })

  it('keeps the dialog mounted when its call leaves the current turn', () => {
    const call = sub({ status: 'completed' })
    const props = { sessionId: 's1', cwd: '', turnActive: false, filePathContext: undefined }
    const { rerender } = render(<ChatStatusPill toolCalls={[call]} messages={[user]} {...props} />)
    fireEvent.click(pill())
    fireEvent.click(screen.getByRole('button', { name: /^done\s*Audit code/ }))
    rerender(
      <ChatStatusPill
        toolCalls={[call]}
        messages={[user, { ...user, id: 'u2', seq: 10 }]}
        {...props}
      />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('counts a launched background agent as running and tags its row', () => {
    const launched = sub({
      status: 'completed',
      subagentLifecycle: { background: true, outputFile: '/tmp/a1.output' }
    })
    renderPill([launched])
    expect(pill()).toHaveAccessibleName('Session status: subagents 1 running')
    fireEvent.click(pill())
    const row = screen.getByRole('button', { name: /^running\s*Audit code/ })
    expect(within(row).getByText('background')).toBeInTheDocument()
    fireEvent.click(row)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Running in background')).toBeInTheDocument()
    expect(within(dialog).getByText('Output file: /tmp/a1.output')).toBeInTheDocument()
  })

  it('says the chat waits on background subagents after the turn ends, and logs it once', () => {
    vi.mocked(logFrontendError).mockClear()
    const launched = sub({ status: 'completed', subagentLifecycle: { background: true } })
    const done = sub({ toolCallId: 'b', status: 'completed' })
    const { rerender } = renderPill([launched, done], { turnActive: false })
    expect(pill()).toHaveAccessibleName(
      'Session status: subagents 1 running, 1 done; waiting on 1 background subagent'
    )
    fireEvent.click(pill())
    const popover = screen.getByRole('dialog', { name: 'Subagents' })
    expect(within(popover).getByText('Waiting on 1 background subagent')).toBeInTheDocument()

    const ended = {
      ...launched,
      subagentLifecycle: { background: true, state: 'completed' as const }
    }
    rerender(<ChatStatusPill toolCalls={[ended, done]} {...base} turnActive={false} />)
    expect(pill()).toHaveAccessibleName('Session status: subagents 2 done')
    expect(screen.queryByText(/^Waiting on/)).toBeNull()
    expect(vi.mocked(logFrontendError).mock.calls.map(([entry]) => entry.message)).toEqual([
      'Chat s1 waits on 1 background subagent after its turn ended',
      'Chat s1 no longer waits on background subagents'
    ])
  })

  it('lists an earlier turn subagent the host still runs, so the wait has a row', () => {
    const earlier = sub({
      seq: 0,
      status: 'completed',
      subagentLifecycle: { background: true, state: 'running' }
    })
    renderPill([earlier], { turnActive: false })
    expect(pill()).toHaveAccessibleName(
      'Session status: subagents 1 running; waiting on 1 background subagent'
    )
    fireEvent.click(pill())
    const popover = screen.getByRole('dialog', { name: 'Subagents' })
    expect(within(popover).getByText('Waiting on 1 background subagent')).toBeInTheDocument()
    expect(within(popover).getAllByRole('button', { name: /Audit code/ })).toHaveLength(1)
    expect(
      within(popover).getByRole('button', { name: /^running\s*Audit code/ })
    ).toBeInTheDocument()
  })

  it('does not say it waits while the turn is still running', () => {
    const launched = sub({ status: 'completed', subagentLifecycle: { background: true } })
    renderPill([launched])
    expect(pill()).toHaveAccessibleName('Session status: subagents 1 running')
  })

  it('opens a bottom sheet on the phone shell and registers it for Back', () => {
    mobileRef.current = true
    renderPill([sub({ status: 'completed' }), sub({ toolCallId: 'b', status: 'in_progress' })])
    expect(pill()).toHaveTextContent(/^2$/)
    fireEvent.click(pill())
    const sheet = screen.getByRole('dialog', { name: 'Subagents' })
    expect(sheet).toHaveAttribute('data-sheet')
    expect(useOverlayStackStore.getState().stack.map((e) => e.id)).toEqual(['chat-status-sheet'])
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    expect(useOverlayStackStore.getState().stack).toEqual([])
  })
})
