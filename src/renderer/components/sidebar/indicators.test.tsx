import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  CrashedMark,
  IdleAgentMark,
  NeedsYouButton,
  ProjectStatusMarks,
  RunningMark,
  resolveProjectLiveState
} from './indicators'

// Issue #859: beside a long project name, the "N need you" badge and the
// "Running" label squeezed the project name span to a single letter. The
// redesign keeps both small and fixed: the needs-you pill shows only a dot +
// count (full label on title/aria-label), and running is a 12px spinner.
describe('sidebar indicators', () => {
  it('NeedsYouButton is a compact warning pill with dot + count and the full label for a11y', () => {
    render(<NeedsYouButton count={3} onOpen={() => {}} />)

    const button = screen.getByRole('button', { name: '3 need you' })
    expect(button).toHaveAttribute('title', '3 need you')
    expect(button).toHaveTextContent(/^3$/)
    expect(button).toHaveClass('h-5', 'rounded-full', 'bg-warning/10', 'text-3xs', 'text-warning')
  })

  it('NeedsYouButton renders nothing for a zero count', () => {
    const { container } = render(<NeedsYouButton count={0} />)
    expect(container.innerHTML).toBe('')
  })

  it('RunningMark is a primary 12px spinner with the accessible name "Running"', () => {
    render(<RunningMark />)

    const mark = screen.getByTitle('An agent chat is still running')
    expect(mark).toHaveClass('text-primary', 'shrink-0')
    expect(screen.getByRole('status', { name: 'Running' })).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })

  it('IdleAgentMark is a muted dot, not a blue spinner', () => {
    const { container } = render(<IdleAgentMark />)

    expect(screen.getByRole('img', { name: 'Agent running, idle' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('text-primary')
    expect(container.querySelector('.bg-muted-foreground\\/60')).toBeTruthy()
  })

  it('CrashedMark shows "Crashed" in warning without a pulse', () => {
    render(<CrashedMark />)

    const mark = screen.getByTitle('Terminal crashed')
    expect(mark).toHaveTextContent('Crashed')
    expect(mark).toHaveClass('text-warning')
    expect(mark.className).not.toContain('animate-pulse')
  })

  it('resolveProjectLiveState: activity wins, then an idle agent, else nothing', () => {
    expect(resolveProjectLiveState(true, true)).toBe('activity')
    expect(resolveProjectLiveState(true, false)).toBe('activity')
    expect(resolveProjectLiveState(false, true)).toBe('idle-agent')
    expect(resolveProjectLiveState(false, false)).toBeNull()
  })

  it('ProjectStatusMarks renders the live mark, needs-you pill and crash mark from one status', () => {
    const onOpen = vi.fn()
    render(
      <ProjectStatusMarks
        status={{ live: 'activity', attentionCount: 2, crashed: true }}
        onOpenNeedsYou={onOpen}
      />
    )

    expect(screen.getByRole('status', { name: 'Project activity' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '2 need you' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.getByTitle('Terminal crashed')).toBeInTheDocument()
  })

  it('ProjectStatusMarks shows the idle dot (not a spinner) for an idle agent', () => {
    render(
      <ProjectStatusMarks
        status={{ live: 'idle-agent', attentionCount: 0, crashed: false }}
        onOpenNeedsYou={() => {}}
      />
    )

    expect(screen.getByRole('img', { name: 'Agent running, idle' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
