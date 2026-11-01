import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
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

const subagent: ToolCall = {
  toolCallId: 'a1',
  seq: 2,
  timestamp: 2,
  status: 'completed',
  rawInput: { description: 'Audit code', prompt: 'p', subagent_type: 'Explore' }
}

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
    <ChatStatusPill
      sessionId="s1"
      cwd=""
      toolCalls={toolCalls}
      messages={[user]}
      turnActive={false}
      filePathContext={undefined}
      hidden={hidden}
    />
  )
}

const pill = () => screen.getByRole('button', { name: /^Session status:/ })
const selectedTab = () => screen.getByRole('tab', { selected: true })
const panelOf = (tab: HTMLElement) =>
  document.getElementById(tab.getAttribute('aria-controls') ?? '') as HTMLElement

describe('ChatStatusPill tabs', () => {
  beforeEach(() => {
    mobileRef.current = false
    useOverlayStackStore.setState({ stack: [] })
  })

  it('renders no pill without subagents or changed files, or while hidden', () => {
    render(<Pill toolCalls={[]} />)
    expect(screen.queryByRole('button')).toBeNull()
    render(<Pill toolCalls={[subagent, ...EDITS]} hidden />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('summarizes both kinds on the pill', () => {
    render(<Pill toolCalls={[subagent, ...EDITS]} />)
    expect(pill()).toHaveAccessibleName('Session status: subagents 1 done; 2 changed files')
    // The lone "1" is the subagent total a narrow pane shows instead of the counts.
    expect(pill()).toHaveTextContent('1 done1·2+2 −2')
  })

  it('shows a tab bar only when both kinds have rows', () => {
    const { rerender } = render(<Pill toolCalls={[subagent]} />)
    fireEvent.click(pill())
    expect(screen.getByRole('dialog', { name: 'Subagents' })).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()

    rerender(<Pill toolCalls={[subagent, ...EDITS]} />)
    const overlay = screen.getByRole('dialog', { name: 'Session status' })
    expect(
      within(overlay)
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual(['Changed files2', 'Subagents1'])
  })

  it('switches tabs inside the same open overlay', () => {
    render(<Pill toolCalls={[subagent, ...EDITS]} />)
    fireEvent.click(pill())
    const overlay = screen.getByRole('dialog', { name: 'Session status' })
    const files = screen.getByRole('tab', { name: /Changed files/ })
    const subagents = screen.getByRole('tab', { name: /Subagents/ })
    const filesPanel = panelOf(files)
    const subagentsPanel = panelOf(subagents)
    expect(files).toHaveAttribute('aria-selected', 'true')
    expect(filesPanel).not.toHaveAttribute('inert')
    expect(subagentsPanel).toHaveAttribute('inert')
    expect(within(subagentsPanel).getByRole('button', { name: /Audit code/ })).toBeInTheDocument()

    fireEvent.click(subagents)
    expect(screen.getByRole('dialog', { name: 'Session status' })).toBe(overlay)
    expect(panelOf(subagents)).toBe(subagentsPanel)
    expect(subagents).toHaveAttribute('aria-selected', 'true')
    expect(files).toHaveAttribute('aria-selected', 'false')
    expect(subagentsPanel).not.toHaveAttribute('inert')
    expect(filesPanel).toHaveAttribute('inert')
  })

  it('moves between tabs with the arrow keys', () => {
    render(<Pill toolCalls={[subagent, ...EDITS]} />)
    fireEvent.click(pill())
    fireEvent.keyDown(selectedTab(), { key: 'ArrowRight' })
    expect(selectedTab()).toHaveTextContent('Subagents')
    expect(selectedTab()).toHaveFocus()
    fireEvent.keyDown(selectedTab(), { key: 'Home' })
    expect(selectedTab()).toHaveTextContent('Changed files')
  })

  it('opens on the last picked tab while it has rows, else on Changed files', () => {
    const { rerender } = render(<Pill toolCalls={[subagent, ...EDITS]} />)
    fireEvent.click(pill())
    expect(selectedTab()).toHaveTextContent('Changed files')
    fireEvent.click(screen.getByRole('tab', { name: /Subagents/ }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(pill())
    expect(selectedTab()).toHaveTextContent('Subagents')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    // The picked tab has no rows: the files list shows alone.
    rerender(<Pill toolCalls={EDITS} />)
    fireEvent.click(pill())
    expect(screen.getByRole('dialog', { name: 'Changed files' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    rerender(<Pill toolCalls={[subagent, ...EDITS]} />)
    fireEvent.click(pill())
    expect(selectedTab()).toHaveTextContent('Subagents')
  })

  it('opens one bottom sheet with both tabs on the phone shell', () => {
    mobileRef.current = true
    render(<Pill toolCalls={[subagent, ...EDITS]} />)
    expect(pill()).toHaveTextContent(/^1·2$/)
    fireEvent.click(pill())
    const sheet = screen.getByRole('dialog', { name: 'Session status' })
    expect(sheet).toHaveAttribute('data-sheet')
    expect(useOverlayStackStore.getState().stack.map((e) => e.id)).toEqual(['chat-status-sheet'])
    fireEvent.click(within(sheet).getByRole('tab', { name: /Subagents/ }))
    expect(screen.getByRole('dialog', { name: 'Session status' })).toBe(sheet)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    expect(useOverlayStackStore.getState().stack).toEqual([])
  })
})
