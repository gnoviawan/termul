import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { reloadMock } = vi.hoisted(() => ({ reloadMock: vi.fn(async () => undefined) }))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/stores/reload-chat', async (orig) => {
  const actual = await orig<typeof import('@/stores/reload-chat')>()
  return { ...actual, reloadAgentChat: reloadMock }
})

import { useReloadChat } from '@/hooks/use-reload-chat'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { useReloadConfirmStore } from '@/stores/reload-confirm-store'
import { ReloadChatConfirmDialog } from './ReloadChatConfirmDialog'

function seed(subagentLifecycle?: Record<string, unknown>): void {
  useAcpStore.setState({
    ...FRESH,
    sessions: {
      s1: {
        id: 's1',
        agentId: 'agent-1',
        cwd: '/work',
        status: 'active',
        activeTurn: false,
        openTurnId: null
      }
    },
    agents: { 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
    messages: {
      s1: [{ id: 'u1', role: 'user', blocks: [], streaming: false, timestamp: 1, seq: 1 }]
    },
    toolCalls: {
      s1: subagentLifecycle
        ? [
            {
              toolCallId: 'bg-1',
              status: 'completed',
              seq: 2,
              rawInput: { description: 'Audit', prompt: 'p' },
              subagentLifecycle
            }
          ]
        : []
    },
    reloadingChatIds: {}
  } as never)
}

describe('reload with background agents', () => {
  beforeEach(() => {
    reloadMock.mockClear()
    useReloadConfirmStore.setState({ request: null })
  })

  it('reloads at once when no background agent runs', () => {
    seed()
    const { result } = renderHook(() => useReloadChat('s1'))
    act(() => result.current.reload?.())
    expect(reloadMock).toHaveBeenCalledWith('s1')
    expect(useReloadConfirmStore.getState().request).toBeNull()
  })

  it('asks first, and reloads only on confirm', () => {
    seed({ background: true, state: 'running' })
    const { result } = renderHook(() => useReloadChat('s1'))
    act(() => result.current.reload?.())
    expect(reloadMock).not.toHaveBeenCalled()
    expect(useReloadConfirmStore.getState().request).toEqual({
      sessionId: 's1',
      backgroundAgents: 1
    })

    render(<ReloadChatConfirmDialog sessionId="s1" />)
    expect(screen.getByRole('alertdialog')).toHaveTextContent('1 background agent is still running')
    fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }))
    expect(reloadMock).toHaveBeenCalledWith('s1')
    expect(useReloadConfirmStore.getState().request).toBeNull()
  })

  it('does not reload on cancel', () => {
    seed({ background: true, state: 'running' })
    useReloadConfirmStore.setState({ request: { sessionId: 's1', backgroundAgents: 2 } })
    render(<ReloadChatConfirmDialog sessionId="s1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(reloadMock).not.toHaveBeenCalled()
    expect(useReloadConfirmStore.getState().request).toBeNull()
  })

  it('shows nothing for another chat', () => {
    useReloadConfirmStore.setState({ request: { sessionId: 's2', backgroundAgents: 1 } })
    render(<ReloadChatConfirmDialog sessionId="s1" />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
