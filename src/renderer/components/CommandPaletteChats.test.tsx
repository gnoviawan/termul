import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { useAcpStore } from '@/stores/acp-store'
import type { Project } from '@/types/project'
import { CommandPalette } from './CommandPalette'

window.HTMLElement.prototype.scrollIntoView = vi.fn()

const { onOpen, mockLog } = vi.hoisted(() => ({
  onOpen: vi.fn(),
  mockLog: vi.fn(() => Promise.resolve())
}))

vi.mock('@/hooks/use-recent-commands', () => ({
  useRecentCommandIds: () => [],
  useSaveRecentCommand: () => vi.fn(() => Promise.resolve())
}))
vi.mock('@/hooks/use-pinned-commands', () => ({
  usePinnedCommandIds: () => [],
  useTogglePinnedCommand: () => vi.fn(() => Promise.resolve())
}))
vi.mock('@/components/shell/use-chat-card-actions', () => ({
  useChatCardActions: () => ({ onOpen })
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))

const project: Project = {
  id: 'p1',
  name: 'Alpha',
  color: 'blue',
  path: '/repo',
  isGitRepo: true,
  gitBranch: 'main',
  worktrees: [
    {
      id: 'w1',
      name: 'feature',
      branch: 'feat/x',
      path: '/repo/.termul/worktrees/feature',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  ]
}

function renderPalette(chatsProject: Project | null = project) {
  const onClose = vi.fn()
  render(
    <CommandPalette
      isOpen
      onClose={onClose}
      projects={[project]}
      onSwitchProject={vi.fn()}
      chatsProject={chatsProject ?? undefined}
    />
  )
  return { onClose }
}

const type = (value: string): void => {
  fireEvent.change(screen.getByRole('combobox'), { target: { value } })
}
const chatsGroup = (): HTMLElement | null =>
  screen
    .queryByText('Chats', { selector: '[cmdk-group-heading]' })
    ?.closest<HTMLElement>('[cmdk-group]') ?? null

beforeEach(() => {
  vi.clearAllMocks()
  useAcpStore.setState({
    agentConfigs: [],
    sessionIndex: [
      mockSessionIndexEntry({
        id: 'a',
        title: 'Fix login redirect',
        projectId: 'p1',
        cwd: '/repo'
      }),
      mockSessionIndexEntry({
        id: 'b',
        title: 'Refactor billing',
        projectId: 'p1',
        cwd: '/repo/.termul/worktrees/feature'
      }),
      mockSessionIndexEntry({ id: 'c', title: 'Fix other project', projectId: 'p2', cwd: '/x' })
    ]
  })
})

afterEach(() => {
  useAcpStore.setState({ sessionIndex: [] })
})

describe('CommandPalette Chats group', () => {
  it('shows no chats until there is a query', () => {
    renderPalette()
    expect(chatsGroup()).toBeNull()
  })

  it('searches every chat of the active project by title, whatever the worktree pick', () => {
    renderPalette()
    type('refactor')
    const group = chatsGroup() as HTMLElement
    expect(
      within(group)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual([expect.stringContaining('Refactor billing')])

    type('fix')
    // Only this project's chats: the other project's "Fix" chat is not listed.
    expect(within(chatsGroup() as HTMLElement).getAllByRole('option')).toHaveLength(1)
    expect(chatsGroup()).toHaveTextContent('Fix login redirect')
    expect(chatsGroup()).not.toHaveTextContent('Fix other project')
  })

  it('matches the branch line too', () => {
    renderPalette()
    type('feat/x')
    expect(chatsGroup()).toHaveTextContent('Refactor billing')
    expect(chatsGroup()).not.toHaveTextContent('Fix login redirect')
  })

  it('closes the palette, opens the chat and logs the id', () => {
    const { onClose } = renderPalette()
    type('login')
    fireEvent.click(within(chatsGroup() as HTMLElement).getByRole('option'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: '[rail] palette open chat a' })
    )
  })

  it('has no Chats group without a chats project', () => {
    renderPalette(null)
    type('fix')
    expect(chatsGroup()).toBeNull()
  })
})
