import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import { endedState, subagentToolCall } from '@/lib/test-utils/subagent'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ChatStatusChips } from './ChatStatusChips'

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

const subagent: ToolCall = subagentToolCall(
  { role: 'Explore', state: endedState('completed') },
  { toolCallId: 'a1', seq: 2, timestamp: 2, status: 'completed' }
)

const edit = (id: string, path: string): ToolCall => ({
  toolCallId: id,
  kind: 'edit',
  status: 'completed',
  content: [{ type: 'diff', path, oldText: 'old', newText: 'new' }],
  rawInput: { filePath: path }
})

const EDITS = [edit('e1', 'src/a.ts'), edit('e2', 'src/b.ts')]

/** No cwd: the changed files come from the tool calls, with no git read. */
function Pill({ toolCalls, hidden }: { toolCalls: ToolCall[]; hidden?: boolean }) {
  return (
    <ChatStatusChips
      sessionId="s1"
      cwd=""
      toolCalls={toolCalls}
      messages={[user]}
      turnActive={false}
      hidden={hidden}
    />
  )
}

const chips = () =>
  within(screen.getByRole('group', { name: 'Session status' }))
    .getAllByRole('button')
    .map((chip) => chip.getAttribute('aria-label'))
const chip = (name: RegExp) => screen.getByRole('button', { name })
const dot = (button: HTMLElement) => button.querySelector('[data-tone]')?.getAttribute('data-tone')

describe('ChatStatusChips row', () => {
  beforeEach(() => {
    mobileRef.current = false
    useOverlayStackStore.setState({ stack: [] })
  })

  it('renders no chip without subagents or changed files, or while hidden', () => {
    render(<Pill toolCalls={[]} />)
    expect(screen.queryByRole('group', { name: 'Session status' })).toBeNull()
    render(<Pill toolCalls={[subagent, ...EDITS]} hidden />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows one chip per kind with rows, Subagent first and Changes last', () => {
    const { rerender } = render(<Pill toolCalls={EDITS} />)
    expect(chips()).toEqual(['Changes: 2 changed files'])
    rerender(<Pill toolCalls={[subagent, ...EDITS]} />)
    expect(chips()).toEqual(['Subagents: 1 done', 'Changes: 2 changed files'])
    expect(chip(/^Subagents:/)).toHaveTextContent('Subagent1')
    expect(chip(/^Changes:/)).toHaveTextContent('Changes+2 −2')
  })

  it('turns the subagent dot green when all are done, and red when one failed', () => {
    const { rerender } = render(<Pill toolCalls={[subagent]} />)
    expect(dot(chip(/^Subagents:/))).toBe('done')
    const failed = subagentToolCall(
      { role: 'Explore', state: endedState('failed') },
      { toolCallId: 'a2', seq: 3, timestamp: 3, status: 'failed' }
    )
    rerender(<Pill toolCalls={[subagent, failed]} />)
    expect(dot(chip(/^Subagents:/))).toBe('failed')
  })

  it('opens one panel at a time, above its chip', () => {
    render(<Pill toolCalls={[subagent, ...EDITS]} />)
    fireEvent.click(chip(/^Subagents:/))
    const subagents = screen.getByRole('dialog', { name: 'Subagents' })
    expect(subagents).toHaveAttribute('data-side', 'top')
    expect(chip(/^Subagents:/)).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(chip(/^Changes:/))
    expect(screen.queryByRole('dialog', { name: 'Subagents' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Changed files' })).toBeInTheDocument()
    expect(chip(/^Subagents:/)).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes the panel on Esc and on a second click of its chip', async () => {
    render(<Pill toolCalls={[subagent, ...EDITS]} />)
    // A real click focuses the chip first; the panel returns focus to it.
    chip(/^Changes:/).focus()
    fireEvent.click(chip(/^Changes:/))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(chip(/^Changes:/)).toHaveFocus())

    fireEvent.click(chip(/^Changes:/))
    fireEvent.click(chip(/^Changes:/))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes the panel when its chip goes away', () => {
    const { rerender } = render(<Pill toolCalls={[subagent, ...EDITS]} />)
    fireEvent.click(chip(/^Changes:/))
    rerender(<Pill toolCalls={[subagent]} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(chips()).toEqual(['Subagents: 1 done'])
    // It does not open again when the chip comes back.
    rerender(<Pill toolCalls={[subagent, ...EDITS]} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens a bottom sheet per chip on the phone shell and registers it for Back', () => {
    mobileRef.current = true
    render(<Pill toolCalls={[subagent, ...EDITS]} />)
    fireEvent.click(chip(/^Changes:/))
    const sheet = screen.getByRole('dialog', { name: 'Changed files' })
    expect(sheet).toHaveAttribute('data-sheet')
    expect(useOverlayStackStore.getState().stack.map((e) => e.id)).toEqual(['chat-status-sheet'])
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    expect(useOverlayStackStore.getState().stack).toEqual([])
  })
})
