import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { reloadMock } = vi.hoisted(() => ({ reloadMock: vi.fn(async () => undefined) }))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/stores/reload-chat', async (orig) => {
  const actual = await orig<typeof import('@/stores/reload-chat')>()
  return { ...actual, reloadAgentChat: reloadMock }
})

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { useReloadConfirmStore } from '@/stores/reload-confirm-store'
import { ReloadChatMenuItem } from './ReloadChatMenuItem'

function seed(session: Record<string, unknown> | null, toolCalls: unknown[] = []): void {
  useAcpStore.setState({
    ...FRESH,
    sessions: session
      ? {
          s1: {
            id: 's1',
            agentId: 'agent-1',
            cwd: '/work',
            status: 'active',
            activeTurn: false,
            openTurnId: null,
            ...session
          }
        }
      : {},
    agents: { 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
    messages: {
      s1: [{ id: 'u1', role: 'user', blocks: [], streaming: false, timestamp: 1, seq: 1 }]
    },
    toolCalls: { s1: toolCalls },
    reloadingChatIds: {}
  } as never)
}

async function openItem(): Promise<HTMLElement> {
  render(
    <ContextMenu>
      <ContextMenuTrigger>target</ContextMenuTrigger>
      <ContextMenuContent>
        <ReloadChatMenuItem sessionId="s1" />
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByText('target'))
  return screen.findByRole('menuitem', { name: 'Reload this chat' })
}

describe('ReloadChatMenuItem', () => {
  beforeEach(() => {
    reloadMock.mockClear()
    useReloadConfirmStore.setState({ request: null })
  })

  it('reloads the chat when chosen', async () => {
    seed({})
    const item = await openItem()
    expect(item).not.toHaveAttribute('aria-disabled')
    fireEvent.click(item)
    expect(reloadMock).toHaveBeenCalledWith('s1')
  })

  it('asks to confirm first while background agents run', async () => {
    seed({}, [
      {
        toolCallId: 'bg-1',
        status: 'completed',
        seq: 2,
        rawInput: { description: 'Audit', prompt: 'p' },
        subagentLifecycle: { background: true, state: 'running' }
      }
    ])
    fireEvent.click(await openItem())
    expect(reloadMock).not.toHaveBeenCalled()
    expect(useReloadConfirmStore.getState().request).toEqual({
      sessionId: 's1',
      backgroundAgents: 1
    })
  })

  it('is disabled and shows the reason while a reply runs', async () => {
    seed({ activeTurn: true, openTurnId: 't1' })
    const item = await openItem()
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(within(item).getByTitle('Wait until this reply finishes.')).toBeInTheDocument()
    fireEvent.click(item)
    expect(reloadMock).not.toHaveBeenCalled()
  })
})
