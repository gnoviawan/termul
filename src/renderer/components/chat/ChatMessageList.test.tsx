import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { seedSession } from '@/stores/acp-store/testkit'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'
import { ChatMessageList } from './ChatMessageList'
import type { TimelineItem } from './chat-timeline'

const { mobileShellRef, virtualizerOverride } = vi.hoisted(() => ({
  mobileShellRef: { current: false as boolean },
  virtualizerOverride: { current: null as null | ((options: unknown) => unknown) }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileShellRef.current
}))

// Lets one suite force the windowed render path (jsdom has no layout, so the
// real virtualizer yields no items and the list falls back to normal flow).
vi.mock('@tanstack/react-virtual', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
      // Always run the real hook so the hook order never depends on the override.
      const real = actual.useVirtualizer(options)
      return virtualizerOverride.current ? virtualizerOverride.current(options) : real
    }
  }
})

vi.mock('./ChatMessage', () => ({
  AgentProse: ({
    text,
    filePathContext
  }: {
    text: string
    filePathContext?: { cwd?: string; projectRoot?: string }
  }) => (
    <div
      data-testid="agent-prose"
      data-cwd={filePathContext?.cwd}
      data-project-root={filePathContext?.projectRoot}
    >
      {text}
    </div>
  ),
  ChatMessage: ({
    message
  }: {
    message: { id: string; blocks: Array<{ type: string; text?: string; name?: string }> }
  }) => (
    <div data-testid={`message-${message.id}`}>
      {message.blocks.map((block) => block.text ?? block.name ?? block.type).join('')}
    </div>
  )
}))

const userItem: TimelineItem = {
  kind: 'message',
  key: 'user-1',
  message: {
    id: 'user-1',
    role: 'user',
    blocks: [{ type: 'text', text: 'Please investigate' }],
    streaming: false,
    timestamp: 1_000,
    seq: 1
  }
}

const streamingAgentItem: TimelineItem = {
  kind: 'message',
  key: 'agent-1',
  message: {
    id: 'agent-1',
    role: 'agent',
    blocks: [{ type: 'text', text: 'Working on it' }],
    streaming: true,
    timestamp: 2_000,
    seq: 3
  }
}

const finalAgentItem: TimelineItem = {
  kind: 'message',
  key: 'agent-final',
  message: {
    id: 'agent-final',
    role: 'agent',
    blocks: [{ type: 'text', text: 'Final response' }],
    streaming: false,
    timestamp: 4_200,
    seq: 4
  }
}

const toolItem: TimelineItem = {
  kind: 'tool',
  key: 'tool-1',
  tool: {
    toolCallId: 'tool-1',
    title: 'Reading files',
    kind: 'read',
    rawInput: { path: 'src/a.ts' },
    status: 'in_progress',
    timestamp: 1_500,
    seq: 2
  }
}

const completedToolItem: TimelineItem = {
  ...toolItem,
  tool: { ...toolItem.tool, status: 'completed' }
}

const failedToolItem: TimelineItem = {
  kind: 'tool',
  key: 'tool-failed',
  tool: {
    toolCallId: 'tool-failed',
    title: 'Run checks',
    kind: 'execute',
    rawInput: { command: 'bun run checks' },
    status: 'failed',
    timestamp: 2_000,
    seq: 2
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
      timestamp: 1_200,
      seq: 2
    }
  ]
}

describe('ChatMessageList', () => {
  beforeEach(() => {
    mobileShellRef.current = false
    virtualizerOverride.current = null
  })

  it.each([
    ['before content arrives', [userItem]],
    ['while a thought streams', [userItem, thoughtItem]],
    ['while a tool runs', [userItem, toolItem]],
    ['while an agent response streams', [userItem, streamingAgentItem]]
  ] satisfies Array<[string, TimelineItem[]]>)('shows open Working activity %s', (_, items) => {
    render(<ChatMessageList items={items} sessionId="session-1" showRunningIndicator />)

    const trigger = screen.getByRole('button', { name: /Working/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows the OpenCode status line on the active turn and drops it when the notice clears', () => {
    act(() => {
      seedSession('session-1', 'agent-1')
      useAcpStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          'session-1': {
            ...s.sessions['session-1'],
            opencodeNotice: { compaction: 'started', retryAttempt: null }
          }
        }
      }))
    })
    const { rerender } = render(
      <ChatMessageList items={[userItem]} sessionId="session-1" showRunningIndicator />
    )
    expect(screen.getByRole('button', { name: /Compacting context/ })).toBeInTheDocument()

    act(() => {
      useAcpStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          'session-1': {
            ...s.sessions['session-1'],
            opencodeNotice: { compaction: null, retryAttempt: 2 }
          }
        }
      }))
    })
    rerender(<ChatMessageList items={[userItem]} sessionId="session-1" showRunningIndicator />)
    expect(screen.getByRole('button', { name: /Retrying, attempt 2/ })).toBeInTheDocument()

    act(() => {
      useAcpStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          'session-1': { ...s.sessions['session-1'], opencodeNotice: undefined }
        }
      }))
    })
    rerender(<ChatMessageList items={[userItem]} sessionId="session-1" showRunningIndicator />)
    expect(screen.getByRole('button', { name: /Working/ })).toBeInTheDocument()
  })

  it('collapses completed activity while keeping the final response visible', async () => {
    const { rerender } = render(
      <ChatMessageList
        items={[userItem, toolItem, streamingAgentItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )

    rerender(
      <ChatMessageList
        items={[userItem, completedToolItem, streamingAgentItem, finalAgentItem]}
        sessionId="session-1"
        showRunningIndicator={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Worked for 3s' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    })
    expect(screen.getByText('Final response')).toBeInTheDocument()
  })

  it("rolls the turn's tool calls into one nested disclosure", () => {
    render(
      <ChatMessageList
        items={[userItem, completedToolItem, finalAgentItem]}
        sessionId="session-1"
        showRunningIndicator={false}
      />
    )

    // The rollup lives one level deep: it mounts only once the turn row opens.
    expect(screen.queryByRole('button', { name: 'Read 1 file' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Worked for 3s' }))

    const group = screen.getByRole('button', { name: 'Read 1 file' })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument()

    fireEvent.click(group)
    expect(group).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('a.ts')).toBeInTheDocument()
  })

  it('starts a live run with an unfinished call collapsed', () => {
    render(
      <ChatMessageList items={[userItem, toolItem]} sessionId="session-1" showRunningIndicator />
    )

    expect(screen.getByRole('button', { name: 'Read 1 file' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByText('Reading a.ts…')).toBeNull()
  })

  it('keeps a run collapsed as a thought joins it and narration lands', () => {
    const { rerender } = render(
      <ChatMessageList
        items={[userItem, completedToolItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )
    expect(screen.getByRole('button', { name: 'Read 1 file' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    rerender(
      <ChatMessageList
        items={[userItem, completedToolItem, thoughtItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )
    expect(screen.getByRole('button', { name: 'Thought, read 1 file' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    rerender(
      <ChatMessageList
        items={[userItem, completedToolItem, thoughtItem, streamingAgentItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )
    expect(screen.getByRole('button', { name: 'Thought, read 1 file' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('keeps both an earlier run and the live run collapsed', () => {
    const midReply: TimelineItem = {
      kind: 'message',
      key: 'mid-1',
      message: {
        id: 'mid-1',
        role: 'agent',
        blocks: [{ type: 'text', text: 'Read it, now building' }],
        streaming: true,
        timestamp: 1_600,
        seq: 3
      }
    }
    const buildTool: TimelineItem = {
      kind: 'tool',
      key: 'tool-2',
      tool: {
        toolCallId: 'tool-2',
        title: 'Build',
        kind: 'execute',
        rawInput: { command: 'bun run build' },
        status: 'in_progress',
        timestamp: 1_700,
        seq: 4
      }
    }
    render(
      <ChatMessageList
        items={[userItem, completedToolItem, midReply, buildTool]}
        sessionId="session-1"
        showRunningIndicator
      />
    )

    expect(screen.getByRole('button', { name: 'Read 1 file' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Ran 1 command' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('updates a growing run label in place without animating the old label out', () => {
    const secondRead: TimelineItem = {
      kind: 'tool',
      key: 'tool-2',
      tool: {
        toolCallId: 'tool-2',
        title: 'Read b',
        kind: 'read',
        rawInput: { path: 'src/b.ts' },
        status: 'completed',
        timestamp: 1_600,
        seq: 3
      }
    }
    const { rerender } = render(
      <ChatMessageList
        items={[userItem, completedToolItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )
    expect(screen.getByText('Read 1 file')).toBeInTheDocument()

    rerender(
      <ChatMessageList
        items={[userItem, completedToolItem, secondRead]}
        sessionId="session-1"
        showRunningIndicator
      />
    )
    expect(screen.queryByText('Read 1 file')).toBeNull()
    expect(screen.getAllByText('Read 2 files')).toHaveLength(1)
  })

  it('shimmers the live run label until narration lands', () => {
    const { rerender } = render(
      <ChatMessageList
        items={[userItem, completedToolItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )
    const label = (): Element | null =>
      screen.getByRole('button', { name: 'Read 1 file' }).querySelector('.t-think')
    expect(label()).not.toHaveClass('is-settled')

    rerender(
      <ChatMessageList
        items={[userItem, completedToolItem, streamingAgentItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )
    expect(label()).toHaveClass('is-settled')
  })

  it('keeps a manually opened live run open as more calls join it', () => {
    const secondRead: TimelineItem = {
      kind: 'tool',
      key: 'tool-2',
      tool: {
        toolCallId: 'tool-2',
        title: 'Read b',
        kind: 'read',
        rawInput: { path: 'src/b.ts' },
        status: 'in_progress',
        timestamp: 1_600,
        seq: 3
      }
    }
    const { rerender } = render(
      <ChatMessageList items={[userItem, toolItem]} sessionId="session-1" showRunningIndicator />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Read 1 file' }))
    expect(screen.getByRole('button', { name: 'Read 1 file' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    rerender(
      <ChatMessageList
        items={[userItem, toolItem, secondRead]}
        sessionId="session-1"
        showRunningIndicator
      />
    )
    expect(screen.getByRole('button', { name: 'Read 2 files' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('Reading b.ts…')).toBeInTheDocument()
  })

  it('folds a failed run once activity moves past it and flags it red', () => {
    render(
      <ChatMessageList
        items={[userItem, failedToolItem, streamingAgentItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )

    const trigger = screen.getByRole('button', { name: 'Ran 1 command' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveClass('text-destructive')
  })

  it('splits tool calls into per-run groups around an in-turn reply', () => {
    const buildTool: TimelineItem = {
      kind: 'tool',
      key: 'tool-2',
      tool: {
        toolCallId: 'tool-2',
        title: 'Build',
        kind: 'execute',
        rawInput: { command: 'bun run build' },
        status: 'completed',
        timestamp: 1_600,
        seq: 3
      }
    }
    const midReply: TimelineItem = {
      kind: 'message',
      key: 'mid-1',
      message: {
        id: 'mid-1',
        role: 'agent',
        blocks: [{ type: 'text', text: 'Build failed, checking the file' }],
        streaming: false,
        timestamp: 1_700,
        seq: 4
      }
    }
    const searchTool: TimelineItem = {
      kind: 'tool',
      key: 'tool-3',
      tool: {
        toolCallId: 'tool-3',
        title: 'Search',
        kind: 'search',
        rawInput: { query: 'tsconfig' },
        status: 'completed',
        timestamp: 1_800,
        seq: 5
      }
    }
    render(
      <ChatMessageList
        items={[userItem, completedToolItem, buildTool, midReply, searchTool, finalAgentItem]}
        sessionId="session-1"
        showRunningIndicator={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Worked for 3s' }))

    const firstRun = screen.getByRole('button', { name: 'Read 1 file, ran 1 command' })
    const secondRun = screen.getByRole('button', { name: 'Ran 1 search' })
    const reply = screen.getByText('Build failed, checking the file')
    // The in-turn reply keeps its seat: run, reply, run.
    expect(firstRun.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(reply.compareDocumentPosition(secondRun) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Each group expands to only its own calls.
    fireEvent.click(firstRun)
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('bun run build')).toBeInTheDocument()
    expect(screen.queryByText('tsconfig')).not.toBeInTheDocument()

    fireEvent.click(secondRun)
    expect(screen.getByText('tsconfig')).toBeInTheDocument()
  })

  it('keeps delegation details open when the parent turn completes', async () => {
    const delegation: TimelineItem = {
      kind: 'tool',
      key: 'task-1',
      tool: {
        toolCallId: 'task-1',
        title: 'Audit branch',
        kind: 'think',
        rawInput: {
          subagent_type: 'explorer',
          description: 'Audit branch',
          prompt: 'Review the branch without editing.'
        },
        timestamp: 1_500,
        seq: 2
      }
    }
    const { rerender } = render(
      <ChatMessageList
        items={[userItem, delegation, streamingAgentItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )

    // The finished run folded once the streaming reply took the live tail —
    // open it to reach the delegation card.
    fireEvent.click(screen.getByRole('button', { name: 'Ran 1 agent' }))
    fireEvent.click(screen.getByRole('button', { name: /audit branch/i }))
    expect(screen.getByRole('dialog', { name: 'Audit branch' })).toHaveTextContent('Running')

    rerender(
      <ChatMessageList
        items={[
          userItem,
          {
            ...delegation,
            tool: {
              ...delegation.tool,
              status: 'completed',
              rawOutput: { text: 'No changes needed.' }
            }
          },
          finalAgentItem
        ]}
        sessionId="session-1"
        showRunningIndicator={false}
      />
    )

    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Worked for 3s' })).toHaveAttribute(
          'aria-expanded',
          'false'
        )
        expect(within(screen.getByRole('log')).queryByText('Audit branch')).not.toBeInTheDocument()
      },
      { timeout: 5000 }
    )
    expect(screen.getByRole('dialog', { name: 'Audit branch' })).toHaveTextContent(
      'No changes needed.'
    )
  })

  it('passes the chat file-path context to subagent result prose', () => {
    const delegation: TimelineItem = {
      kind: 'tool',
      key: 'task-1',
      tool: {
        toolCallId: 'task-1',
        title: 'Audit branch',
        kind: 'think',
        status: 'completed',
        rawInput: { subagent_type: 'explorer', description: 'Audit branch' },
        rawOutput: { text: 'Edited src/foo.ts.' },
        timestamp: 1_500,
        seq: 2
      }
    }
    render(
      <ChatMessageList
        items={[userItem, delegation, finalAgentItem]}
        sessionId="session-1"
        showRunningIndicator={false}
        filePathContext={{ cwd: '/proj/sub', projectRoot: '/proj' }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Worked for 3s' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ran 1 agent' }))
    fireEvent.click(screen.getByRole('button', { name: /audit branch/i }))

    const prose = within(screen.getByRole('dialog', { name: 'Audit branch' })).getByTestId(
      'agent-prose'
    )
    expect(prose).toHaveTextContent('Edited src/foo.ts.')
    expect(prose).toHaveAttribute('data-cwd', '/proj/sub')
    expect(prose).toHaveAttribute('data-project-root', '/proj')
  })

  it('allows keyboard-accessible reopening after completion', () => {
    render(
      <ChatMessageList
        items={[userItem, completedToolItem, finalAgentItem]}
        sessionId="session-1"
        showRunningIndicator={false}
      />
    )

    const trigger = screen.getByRole('button', { name: 'Worked for 3s' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    trigger.focus()
    // jsdom does not synthesize the click a real browser fires on Enter, so
    // dispatch the key sequence then the keyboard-generated click (detail 0).
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.keyUp(trigger, { key: 'Enter' })
    fireEvent.click(trigger, { detail: 0 })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps attachment responses visible when later text and an empty tail arrive', async () => {
    const attachmentItem: TimelineItem = {
      kind: 'message',
      key: 'agent-attachment',
      message: {
        id: 'agent-attachment',
        role: 'agent',
        blocks: [{ type: 'resource_link', name: 'report.pdf', uri: 'file:///tmp/report.pdf' }],
        streaming: false,
        timestamp: 2_200,
        seq: 3
      }
    }
    const emptyTailItem: TimelineItem = {
      kind: 'message',
      key: 'agent-empty',
      message: {
        id: 'agent-empty',
        role: 'agent',
        blocks: [{ type: 'text', text: '  ' }],
        streaming: false,
        timestamp: 4_300,
        seq: 5
      }
    }

    render(
      <ChatMessageList
        items={[userItem, completedToolItem, attachmentItem, finalAgentItem, emptyTailItem]}
        sessionId="session-1"
        showRunningIndicator={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Worked for 3s' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    })
    expect(screen.getByTestId('message-agent-attachment')).toHaveTextContent('report.pdf')
    expect(screen.getByTestId('message-agent-final')).toHaveTextContent('Final response')
    expect(screen.queryByTestId('message-agent-empty')).not.toBeInTheDocument()
  })

  it('keeps the live response DOM node stable when later activity arrives', () => {
    const { rerender } = render(
      <ChatMessageList
        items={[userItem, streamingAgentItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )
    const liveNode = screen.getByTestId('message-agent-1')

    rerender(
      <ChatMessageList
        items={[userItem, streamingAgentItem, toolItem]}
        sessionId="session-1"
        showRunningIndicator
      />
    )

    expect(screen.getByTestId('message-agent-1')).toBe(liveNode)
    expect(screen.getByRole('button', { name: 'Read 1 file' })).toBeInTheDocument()
  })

  it('collapses a failed tool-only turn but flags it for attention', () => {
    render(
      <ChatMessageList
        items={[userItem, failedToolItem]}
        sessionId="session-1"
        showRunningIndicator={false}
      />
    )

    const trigger = screen.getByRole('button', { name: /Worked.*needs attention/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    const run = screen.getByRole('button', { name: 'Ran 1 command' })
    expect(run).toHaveAttribute('aria-expanded', 'false')
    expect(run).toHaveClass('text-destructive')
    fireEvent.click(run)
    expect(screen.getByText('bun run checks')).toBeInTheDocument()
  })
})

describe('ChatMessageList worktree progress row', () => {
  beforeEach(() => {
    useWorktreeProgressStore.setState({ ops: {} })
  })

  it('renders a worktree-kind item as a progress row after the user message', () => {
    useWorktreeProgressStore.getState().begin('wt-list-1', 'feat/row')
    render(
      <ChatMessageList
        items={[userItem, { kind: 'worktree', key: 'worktree:wt-list-1', progressId: 'wt-list-1' }]}
        sessionId="session-1"
        showRunningIndicator={false}
      />
    )

    // The 'worktree' render branch mounts WorktreeCreationCard for the op.
    const title = screen.getByText('Creating worktree..')
    expect(title).toBeInTheDocument()
    expect(screen.getByText('Preparing workspace')).toBeInTheDocument()
    // Top-level position: the row lands between the user message and any
    // agent activity (never inside the turn-activity disclosure).
    const userEl = screen.getByTestId('message-user-1')
    expect(userEl.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('ChatMessageList log live semantics', () => {
  beforeEach(() => {
    mobileShellRef.current = false
    virtualizerOverride.current = null
  })

  afterEach(() => {
    mobileShellRef.current = false
    virtualizerOverride.current = null
  })

  const items = [userItem, finalAgentItem]

  function renderList(): void {
    render(
      <ChatMessageList
        items={items}
        sessionId="session-1"
        agentId="agent-1"
        showRunningIndicator={false}
      />
    )
  }

  it('keeps the polite log with additions relevance outside the mobile shell', () => {
    mobileShellRef.current = false
    renderList()

    const log = screen.getByRole('log')
    expect(log).toHaveAttribute('aria-live', 'polite')
    expect(log).toHaveAttribute('aria-relevant', 'additions')
  })

  it('turns the log off on the mobile shell: role stays, aria-live is off, no aria-relevant', () => {
    mobileShellRef.current = true
    renderList()

    const log = screen.getByRole('log')
    expect(log).toHaveAttribute('role', 'log')
    expect(log).toHaveAttribute('aria-live', 'off')
    expect(log).not.toHaveAttribute('aria-relevant')
    // The rows are still all there; only the announcements stopped.
    expect(screen.getByTestId('message-user-1')).toBeInTheDocument()
    expect(screen.getByTestId('message-agent-final')).toBeInTheDocument()
  })

  it.each([
    ['mobile shell', true, 'off', null],
    ['desktop', false, 'polite', 'additions']
  ])('applies the same semantics on the windowed path (%s)', (_, mobile, live, relevant) => {
    mobileShellRef.current = mobile
    virtualizerOverride.current = () => ({
      getVirtualItems: () => [
        { index: 0, key: 'user-1', start: 0, end: 100, size: 100, lane: 0 },
        { index: 1, key: 'agent-final', start: 100, end: 200, size: 100, lane: 0 }
      ],
      getTotalSize: () => 200,
      measureElement: () => undefined,
      scrollToIndex: () => undefined,
      range: { startIndex: 0, endIndex: 1 }
    })
    renderList()

    const log = screen.getByRole('log')
    // The windowed branch positions rows absolutely inside a fixed-height log.
    expect(log.style.position).toBe('relative')
    expect(log).toHaveAttribute('aria-live', live)
    if (relevant === null) expect(log).not.toHaveAttribute('aria-relevant')
    else expect(log).toHaveAttribute('aria-relevant', relevant)
  })

  it('still renders the empty state without a log (hook order is stable across the early return)', () => {
    mobileShellRef.current = true
    const { rerender } = render(
      <ChatMessageList
        items={[]}
        sessionId="session-1"
        agentId="agent-1"
        showRunningIndicator={false}
      />
    )
    expect(screen.queryByRole('log')).not.toBeInTheDocument()

    rerender(
      <ChatMessageList
        items={items}
        sessionId="session-1"
        agentId="agent-1"
        showRunningIndicator={false}
      />
    )
    expect(screen.getByRole('log')).toHaveAttribute('aria-live', 'off')
  })
})
