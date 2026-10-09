import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { ChatEmptyState } from './ChatEmptyState'
import { CHAT_STARTERS, ChatStarters, ChatStartHero } from './chat-start'

describe('ChatStartHero (shared by the launcher and the empty chat)', () => {
  it('shows the Termul mark and the project question', () => {
    render(<ChatStartHero projectLabel="termul-new" headingLevel={2} />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'What should we do in termul-new?'
    )
  })
})

describe('ChatStarters', () => {
  it('lists the four starters as quiet chips and seeds the prompt on pick', () => {
    const onPick = vi.fn()
    render(<ChatStarters onPick={onPick} />)

    const group = screen.getByRole('group', { name: 'Starters' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Explain this project', 'Find a bug', 'Write tests', 'Summarize changes'])
    fireEvent.click(within(group).getByRole('button', { name: 'Find a bug' }))
    expect(onPick).toHaveBeenCalledWith(CHAT_STARTERS[1].prompt)
  })
})

describe('ChatEmptyState', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'termul-new' }] as never
    })
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, 's-1': { id: 's-1', projectId: 'p1' } as never }
    }))
  })

  it('uses the same hero as the launcher, named for the chat project', () => {
    render(<ChatEmptyState sessionId="s-1" />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'What should we do in termul-new?'
    )
    // No agent glyph tile and no starter cards: the starters live under the composer.
    expect(screen.queryByRole('group', { name: 'Starters' })).toBeNull()
  })

  it('falls back to "this folder" without a project', () => {
    render(<ChatEmptyState sessionId="unknown" />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'What should we do in this folder?'
    )
  })
})
