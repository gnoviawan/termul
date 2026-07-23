import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatMessageList } from './ChatMessageList'
import type { TimelineItem } from './chat-timeline'

vi.mock('./ChatMessage', () => ({
  ChatMessage: () => <div>Agent response</div>
}))

const streamingAgentItem: TimelineItem = {
  kind: 'message',
  key: 'agent-1',
  message: {
    id: 'agent-1',
    role: 'agent',
    blocks: [{ type: 'text', text: 'Working on it' }],
    streaming: true,
    timestamp: 0
  }
}

const toolItem: TimelineItem = {
  kind: 'tool',
  key: 'tool-1',
  tool: {
    toolCallId: 'tool-1',
    title: 'Reading files',
    status: 'in_progress',
    timestamp: 0
  }
}

const thoughtItem: TimelineItem = {
  kind: 'thought-group',
  key: 'thought-1',
  messages: [
    {
      id: 'thought-1',
      role: 'thought',
      blocks: [{ type: 'text', text: 'Considering options' }],
      streaming: true,
      timestamp: 0
    }
  ]
}

describe('ChatMessageList', () => {
  it.each([
    ['before content arrives', []],
    ['while a thought streams', [thoughtItem]],
    ['while a tool runs', [toolItem]],
    ['while an agent response streams', [streamingAgentItem]]
  ] satisfies Array<[string, TimelineItem[]]>)('shows the running indicator %s', (_, items) => {
    render(
      <ChatMessageList items={items} sessionId="session-1" agentId="agent-1" showRunningIndicator />
    )

    expect(screen.getByRole('status', { name: 'Agent is working' })).toBeInTheDocument()
  })

  it('removes the running indicator after the turn finishes', async () => {
    const { rerender } = render(
      <ChatMessageList
        items={[streamingAgentItem]}
        sessionId="session-1"
        agentId="agent-1"
        showRunningIndicator
      />
    )

    expect(screen.getByRole('status', { name: 'Agent is working' })).toBeInTheDocument()

    rerender(
      <ChatMessageList
        items={[streamingAgentItem]}
        sessionId="session-1"
        agentId="agent-1"
        showRunningIndicator={false}
      />
    )

    await waitFor(() => {
      expect(screen.queryByRole('status', { name: 'Agent is working' })).not.toBeInTheDocument()
    })
  })
})
