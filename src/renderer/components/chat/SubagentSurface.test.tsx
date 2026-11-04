import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import {
  endedState,
  type SubagentRecordOverrides,
  subagentToolCall
} from '@/lib/test-utils/subagent'
import { useAcpStore } from '@/stores/acp-store'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ChatMessageList } from './ChatMessageList'
import { buildTimeline } from './chat-timeline'
import { SubagentSurfaceProvider } from './SubagentSurface'

const mobileRef = vi.hoisted(() => ({ current: false }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => mobileRef.current }))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function prose({
  text,
  filePathContext
}: {
  text: string
  filePathContext?: FilePathResolutionContext
}): React.JSX.Element {
  return (
    <div
      data-testid="agent-prose"
      data-cwd={filePathContext?.cwd}
      data-project-root={filePathContext?.projectRoot}
    >
      {text}
    </div>
  )
}
vi.mock('./chat-agent-prose', () => ({ AgentProse: prose }))
vi.mock('./ChatMessage', () => ({
  AgentProse: prose,
  ChatMessage: ({ message }: { message: ChatMessage }) => (
    <div>{message.blocks.map((block) => block.text ?? '').join('')}</div>
  )
}))

const SESSION = 's1'

const user: ChatMessage = {
  id: 'u1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Check the auth race' }],
  streaming: false,
  timestamp: 1_000,
  seq: 1
}

const narration: ChatMessage = {
  id: 'a1',
  role: 'agent',
  blocks: [{ type: 'text', text: 'Splitting this into subagents.' }],
  streaming: false,
  timestamp: 1_100,
  seq: 2
}

const finalReply: ChatMessage = {
  id: 'a2',
  role: 'agent',
  blocks: [{ type: 'text', text: 'All done.' }],
  streaming: false,
  timestamp: 9_000,
  seq: 50
}

let seq = 10

function dispatch(
  id: string,
  record: SubagentRecordOverrides = {},
  call: Partial<ToolCall> = {}
): ToolCall {
  seq += 1
  return subagentToolCall(
    { title: id, startedAt: Date.now() - 5_000, ...record },
    { toolCallId: id, seq, timestamp: 1_200, ...call }
  )
}

function child(parent: string, id: string, call: Partial<ToolCall> = {}): ToolCall {
  seq += 1
  return {
    toolCallId: id,
    title: 'Read refresh.rs',
    kind: 'read',
    rawInput: { path: 'src/auth/refresh.rs' },
    status: 'completed',
    parentToolCallId: parent,
    seq,
    timestamp: 1_300,
    ...call
  }
}

interface ChatProps {
  toolCalls: ToolCall[]
  messages?: ChatMessage[]
  turnActive?: boolean
  filePathContext?: FilePathResolutionContext
}

/** A chat transcript inside its subagent surface, with the store holding its calls. */
function Chat({
  toolCalls,
  messages = [user, narration],
  turnActive = true,
  filePathContext
}: ChatProps): React.JSX.Element {
  return (
    <TooltipProvider>
      <SubagentSurfaceProvider
        sessionId={SESSION}
        agentId={undefined}
        toolCalls={toolCalls}
        messages={messages}
        turnActive={turnActive}
        filePathContext={filePathContext}
        isVisible
      >
        <ChatMessageList
          items={buildTimeline(messages, toolCalls)}
          sessionId={SESSION}
          showRunningIndicator={turnActive}
          filePathContext={filePathContext}
        />
      </SubagentSurfaceProvider>
    </TooltipProvider>
  )
}

function renderChat(props: ChatProps) {
  useAcpStore.setState((s) => ({ toolCalls: { ...s.toolCalls, [SESSION]: props.toolCalls } }))
  const view = render(<Chat {...props} />)
  return {
    ...view,
    update(next: ChatProps) {
      useAcpStore.setState((s) => ({ toolCalls: { ...s.toolCalls, [SESSION]: next.toolCalls } }))
      view.rerender(<Chat {...next} />)
    }
  }
}

const panel = () => screen.getByTestId('subagent-panel')
const row = (name: RegExp) => screen.getByRole('button', { name })

describe('subagents in the transcript', () => {
  beforeEach(() => {
    mobileRef.current = false
    seq = 10
    useOverlayStackStore.setState({ stack: [] })
  })
  afterEach(() => {
    useAcpStore.setState({ toolCalls: {} })
  })

  it('groups subagents launched together, outside the tool fold, with a status summary', () => {
    renderChat({
      toolCalls: [
        child('audit', 'c1', { status: 'in_progress' }),
        dispatch('audit', { title: 'Audit auth flow', role: 'Explore' }),
        dispatch(
          'tests',
          { title: 'Fix session tests', state: endedState() },
          { status: 'completed', rawOutput: { text: 'Fixed 2 assertions.\nAll pass.' } }
        ),
        dispatch(
          'lint',
          {
            title: 'Lint the renderer',
            state: { activity: 'idle', end: { reason: 'failed', error: 'ENOENT biome.json' } }
          },
          { status: 'failed' }
        ),
        { toolCallId: 'r1', kind: 'read', rawInput: { path: 'a.ts' }, status: 'completed', seq: 40 }
      ]
    })

    expect(
      screen.getByRole('button', { name: '3 subagents: 1 working, 1 done, 1 failed' })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('3 subagents')).toBeVisible()
    expect(row(/^Audit auth flow.*Working/)).toHaveTextContent(
      /Audit auth flowExploreReading refresh.rs · 1 toolWorking/
    )
    expect(row(/^Fix session tests.*Done/)).toHaveTextContent('Fixed 2 assertions.')
    expect(row(/^Fix session tests.*Done/)).not.toHaveTextContent('All pass.')
    expect(row(/^Lint the renderer.*Failed/)).toHaveTextContent('ENOENT biome.json')
    // The plain read stays in its own fold.
    expect(screen.getByRole('button', { name: /^Read 1 file/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('shows a single subagent as one card without a group header', () => {
    renderChat({ toolCalls: [dispatch('map', { title: 'Map the UI', role: 'Explore' })] })
    expect(row(/^Map the UI.*Working/)).toBeInTheDocument()
    expect(screen.queryByText(/subagents$/)).toBeNull()
  })

  it('folds and dims the group once every subagent settled', async () => {
    const live = [dispatch('a'), dispatch('b')]
    const { update } = renderChat({ toolCalls: live })
    const header = () => screen.getByRole('button', { name: /^2 subagents/ })
    expect(header()).toHaveAttribute('aria-expanded', 'true')

    update({
      toolCalls: live.map((tc) => ({
        ...tc,
        status: 'completed' as const,
        subagent: { ...tc.subagent!, ...endedState() }
      })),
      messages: [user, narration],
      turnActive: true
    })
    await waitFor(() => expect(header()).toHaveAttribute('aria-expanded', 'false'))
    expect(header()).toHaveAccessibleName('2 subagents: 2 done')
    expect(header().closest('[data-subagent-group]')).toHaveClass('opacity-60')
  })

  it('opens the panel from a row with its place in the group and the reported metadata', () => {
    renderChat({
      toolCalls: [
        dispatch('a', { title: 'Audit auth flow' }),
        dispatch('b', {
          title: 'Fix session tests',
          role: 'Explore',
          model: 'Opus 4.5',
          usage: { totalTokens: 37_800 },
          prompt: 'Fix the failing session tests.'
        }),
        child('b', 'c1'),
        child('b', 'c2')
      ]
    })
    fireEvent.click(row(/^Fix session tests/))
    expect(panel()).toHaveTextContent('Subagent of this chat · 2 of 2')
    expect(within(panel()).getByRole('heading', { name: 'Fix session tests' })).toBeVisible()
    expect(panel()).toHaveTextContent('Explore · Opus 4.5 · 2 tools · 37.8k tok')
    expect(panel()).toHaveTextContent('Fix the failing session tests.')
    expect(panel()).toHaveTextContent('Activity · 2')
    expect(row(/^Fix session tests/)).toHaveAttribute('aria-current', 'true')

    fireEvent.keyDown(panel(), { key: 'ArrowUp' })
    expect(within(panel()).getByRole('heading', { name: 'Audit auth flow' })).toBeVisible()
    expect(panel()).toHaveTextContent('1 of 2')

    fireEvent.click(within(panel()).getByRole('button', { name: 'Back to chat' }))
    expect(screen.queryByTestId('subagent-panel')).toBeNull()
  })

  it('hides sections the agent did not report, saying why in one line', () => {
    renderChat({
      toolCalls: [
        dispatch('final', { title: 'Cursor task', caps: { transcript: 'final' } }),
        dispatch('bare', { title: 'Bare task', caps: { transcript: 'none' } })
      ]
    })
    fireEvent.click(row(/^Cursor task/))
    expect(panel()).toHaveTextContent('The agent did not share the task it gave this subagent.')
    expect(panel()).toHaveTextContent("reports only this subagent's result, not its steps.")
    expect(panel()).toHaveTextContent('The result shows here when it finishes.')
    expect(within(panel()).queryByRole('heading', { name: /^Activity/ })).toBeNull()
    expect(within(panel()).queryByRole('heading', { name: 'Task' })).toBeNull()

    fireEvent.click(row(/^Bare task/))
    expect(panel()).toHaveTextContent("doesn't report what this subagent does.")
  })

  it('shows the latest message while running and the result once settled, never twice', async () => {
    const running = dispatch(
      'a',
      { title: 'Audit auth flow' },
      { subagentText: 'So far the race is in session.ts:143.' }
    )
    const { update } = renderChat({ toolCalls: [running] })
    fireEvent.click(row(/^Audit auth flow/))
    expect(within(panel()).getByRole('heading', { name: 'Latest message' })).toBeVisible()
    expect(within(panel()).getByTestId('agent-prose')).toHaveTextContent('session.ts:143')

    const finalText = 'The race is in session.ts:143; refresh() runs without the lock.'
    update({
      toolCalls: [
        {
          ...running,
          status: 'completed',
          subagentText: finalText,
          content: [{ type: 'content', content: { type: 'text', text: finalText } }],
          subagent: { ...running.subagent!, ...endedState() }
        }
      ],
      messages: [user, narration, finalReply],
      turnActive: false
    })
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: 'Result' })).toBeVisible()
    )
    expect(within(panel()).queryByRole('heading', { name: 'Latest message' })).toBeNull()
    expect(within(panel()).getAllByText(finalText)).toHaveLength(1)
    expect(within(panel()).getByText('Done')).toBeVisible()
  })

  it('opens a nested subagent from Activity and returns to its parent on Back', () => {
    renderChat({
      toolCalls: [
        dispatch('parent', { title: 'Plan the fix' }),
        child('parent', 'c1'),
        dispatch('nested', { title: 'Read the spec' }, { parentToolCallId: 'parent' })
      ]
    })
    expect(screen.queryByRole('button', { name: /^Read the spec/ })).toBeNull()
    fireEvent.click(row(/^Plan the fix/))
    expect(panel()).toHaveTextContent('Activity · 2')
    fireEvent.click(within(panel()).getByRole('button', { name: /^Read the spec/ }))
    expect(within(panel()).getByRole('heading', { name: 'Read the spec' })).toBeVisible()
    fireEvent.click(within(panel()).getByRole('button', { name: 'Back' }))
    expect(within(panel()).getByRole('heading', { name: 'Plan the fix' })).toBeVisible()
    fireEvent.click(within(panel()).getByRole('button', { name: 'Back' }))
    expect(screen.queryByTestId('subagent-panel')).toBeNull()
  })

  it('keeps the panel open when the turn completes and folds the transcript', async () => {
    const running = dispatch('a', { title: 'Audit branch', prompt: 'Review it.' })
    const { update } = renderChat({ toolCalls: [running] })
    fireEvent.click(row(/^Audit branch/))
    expect(within(panel()).getByText('Working')).toBeVisible()

    update({
      toolCalls: [
        {
          ...running,
          status: 'completed',
          rawOutput: { text: 'No changes needed.' },
          subagent: { ...running.subagent!, ...endedState() }
        }
      ],
      messages: [user, narration, finalReply],
      turnActive: false
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Worked/ })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    )
    expect(panel()).toHaveTextContent('No changes needed.')
  })

  it('passes the chat file-path context to the result prose', () => {
    renderChat({
      toolCalls: [
        dispatch(
          'a',
          { title: 'Audit branch', state: endedState() },
          { status: 'completed', rawOutput: { text: 'Edited src/foo.ts.' } }
        )
      ],
      filePathContext: { cwd: '/proj/sub', projectRoot: '/proj' }
    })
    fireEvent.click(row(/^Audit branch/))
    const result = within(panel()).getByTestId('agent-prose')
    expect(result).toHaveTextContent('Edited src/foo.ts.')
    expect(result).toHaveAttribute('data-cwd', '/proj/sub')
    expect(result).toHaveAttribute('data-project-root', '/proj')
  })

  it('opens a full-height bottom sheet on the phone and closes it with system Back', () => {
    mobileRef.current = true
    renderChat({ toolCalls: [dispatch('a', { title: 'Audit auth flow' })] })
    fireEvent.click(row(/^Audit auth flow/))
    const sheet = screen.getByRole('dialog', { name: 'Audit auth flow' })
    expect(sheet).toHaveAttribute('data-sheet')
    expect(useOverlayStackStore.getState().stack.map((e) => e.id)).toEqual(['subagent-panel'])
    act(() => {
      useOverlayStackStore.getState().stack.at(-1)?.close()
    })
    expect(screen.queryByRole('dialog', { name: 'Audit auth flow' })).toBeNull()
  })
})
