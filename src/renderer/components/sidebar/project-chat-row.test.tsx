import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatRowTrail } from './project-chat-row'

describe('ChatRowTrail', () => {
  it('shows a visible, neutral "New" mark for done (no blue)', () => {
    render(<ChatRowTrail liveState="done" lastActivityAt={0} />)
    const mark = screen.getByText('New')
    expect(mark).toHaveAttribute('title', 'New activity')
    expect(mark).toHaveClass('text-foreground')
    expect(mark.querySelector('.bg-primary-fill')).toBeNull()
  })

  it('prefixes the idle time with Closed for a closed chat', () => {
    const { rerender } = render(<ChatRowTrail liveState="idle" lastActivityAt={Date.now()} />)
    expect(screen.queryByText(/^Closed/)).not.toBeInTheDocument()
    rerender(<ChatRowTrail liveState="idle" lastActivityAt={Date.now()} closed />)
    expect(screen.getByText(/^Closed · /)).toBeInTheDocument()
  })

  it('shows the Needs you word and the running spinner', () => {
    const { rerender } = render(<ChatRowTrail liveState="needs-you" lastActivityAt={0} />)
    expect(screen.getByText('Needs you')).toBeInTheDocument()
    rerender(<ChatRowTrail liveState="running" lastActivityAt={0} />)
    expect(screen.getByRole('status', { name: 'Running' })).toBeInTheDocument()
  })
})
