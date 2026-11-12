import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundCommand, ToolCall } from '@/lib/acp-api'
import { useAcpStore } from '@/stores/acp-store'
import type { AcpSession } from '@/stores/acp-store/types'
import { useToolCallRevealStore } from '@/stores/tool-call-reveal-store'
import { SubagentSurfaceContext } from './subagent-surface-context'
import { ToolCallCard } from './ToolCallCard'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

const NOW = 1_800_000_000_000

const call: ToolCall = {
  toolCallId: 'toolu_bg',
  title: 'sleep 25; echo probe-done',
  kind: 'execute',
  status: 'completed',
  rawInput: { command: 'sleep 25; echo probe-done', description: 'Sleep then print probe-done' },
  content: [{ type: 'content', content: { type: 'text', text: 'Command running in background' } }]
}

function seed(command: BackgroundCommand): void {
  useAcpStore.setState({
    sessions: {
      s1: {
        id: 's1',
        agentId: 'agent-1',
        status: 'active',
        backgroundCommands: { agentId: 'agent-1', revision: 1, commands: [command] }
      } as unknown as AcpSession
    }
  })
}

function renderCard(): void {
  render(
    <SubagentSurfaceContext.Provider
      value={{
        sessionId: 's1',
        agentId: 'agent-1',
        filePathContext: undefined,
        openId: null,
        opensDialog: false,
        open: () => {}
      }}
    >
      <ToolCallCard toolCall={call} />
    </SubagentSurfaceContext.Provider>
  )
}

const running: BackgroundCommand = {
  toolCallId: 'toolu_bg',
  title: 'Sleep then print probe-done',
  command: 'sleep 25; echo probe-done',
  startedAtMs: NOW - 12_000,
  state: 'running'
}

describe('ToolCallCard background commands', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    useToolCallRevealStore.setState({ target: null })
  })

  it('shows a command still running in the background with a live timer', () => {
    seed(running)
    renderCard()
    const row = screen.getByRole('button', { expanded: false })
    expect(row).toHaveTextContent('Running in background sleep 25; echo probe-done')
    expect(row.closest('[data-background]')).toHaveAttribute('aria-busy', 'true')
    expect(row.parentElement).toHaveTextContent('12s')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(row.parentElement).toHaveTextContent('14s')
  })

  it('shows the finished row with the command run time once the command ended', () => {
    seed({ ...running, state: 'ended', endedAtMs: NOW })
    renderCard()
    const row = screen.getByRole('button', { expanded: false })
    expect(row).not.toHaveTextContent('Running in background')
    expect(row).toHaveTextContent('sleep 25; echo probe-done')
    expect(row.parentElement).toHaveTextContent('12s')
    expect(row.closest('[data-status]')).not.toHaveAttribute('aria-busy')
  })

  it('ignores a Background row of another chat showing the same tool call id', () => {
    seed(running)
    renderCard()
    act(() => {
      useToolCallRevealStore.getState().reveal('s2', 'toolu_bg')
    })
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
  })

  it('opens and scrolls to itself when a Background row asks for it', () => {
    seed(running)
    renderCard()
    const scrollIntoView = vi.fn()
    const card = screen.getByRole('button', { expanded: false }).closest('[data-status]')
    if (!(card instanceof HTMLElement)) throw new Error('card root')
    card.scrollIntoView = scrollIntoView

    act(() => {
      useToolCallRevealStore.getState().reveal('s1', 'toolu_bg')
    })
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()
    expect(scrollIntoView).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })
})
