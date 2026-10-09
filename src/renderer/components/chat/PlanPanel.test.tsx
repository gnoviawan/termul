import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { TermulPlanRenderer } from './ChatMarkdownPlanFence'
import { PlanPanel } from './PlanPanel'

describe('PlanPanel', () => {
  it('splits task names from direct and metadata details in expandable rows', async () => {
    render(
      <PlanPanel
        entries={[
          {
            content: 'Build the UI',
            detail: 'Use the existing primitives for the task details.',
            status: 'in_progress'
          },
          {
            content: 'Run checks',
            _meta: { detail: 'Run the focused renderer tests.' },
            status: 'pending'
          }
        ]}
      />
    )

    expect(screen.getByRole('button', { name: /Build the UI/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run checks/ })).toBeInTheDocument()
    expect(screen.queryByText('Use the existing primitives for the task details.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Build the UI/ }))
    await waitFor(() => {
      expect(screen.getByText('Use the existing primitives for the task details.')).toBeVisible()
    })

    fireEvent.click(screen.getByRole('button', { name: /Run checks/ }))
    await waitFor(() => {
      expect(screen.getByText('Run the focused renderer tests.')).toBeVisible()
    })
  })

  it('keeps entries without detail as simple rows', () => {
    render(<PlanPanel entries={[{ content: 'No detail', status: 'completed' }]} />)

    expect(screen.getByText('No detail')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /No detail/ })).toBeNull()
    expect(screen.getByText('No detail')).toHaveClass('line-through')
  })

  it('shows a text priority badge instead of a color-only dot', () => {
    render(
      <PlanPanel
        entries={[
          { content: 'Urgent', priority: 'high', status: 'pending' },
          { content: 'Later', priority: 'low', status: 'pending' }
        ]}
      />
    )
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('Low')).toBeInTheDocument()
  })

  it('bounds long plans and updates status while the panel is live', () => {
    const { container, rerender } = render(
      <PlanPanel entries={Array.from({ length: 20 }, (_, i) => ({ content: `Task ${i}` }))} />
    )

    const scroller = container.querySelector('.max-h-60')
    expect(scroller).toBeInTheDocument()
    expect(scroller).toHaveClass('overflow-y-auto')
    expect(screen.getByText('Task 0').parentElement).toHaveClass('min-h-7')

    rerender(<PlanPanel entries={[{ content: 'Task 0', status: 'completed' }]} />)
    expect(screen.getByText('Task 0')).toHaveClass('line-through')
  })

  it('collapses to just the header when the chevron toggle is clicked', async () => {
    const { container } = render(
      <PlanPanel
        entries={[
          { content: 'Task A', status: 'in_progress', priority: 'high' },
          { content: 'Task B', status: 'pending', priority: 'low' }
        ]}
      />
    )

    // Header button is present and expanded by default
    const toggle = screen.getByRole('button', { name: /Plan, 0 of 2 tasks, task in progress/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector('.max-h-60')).toBeInTheDocument()
    expect(screen.getByText('Task A')).toBeInTheDocument()

    // Collapse: the body plays the close, then unmounts. Header stays.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => {
      expect(container.querySelector('.max-h-60')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('Task A')).toBeNull()
    // Header counter is still surfaced via the toggle button's aria-label
    // (which includes the count), even though the body is collapsed.
    expect(toggle).toHaveAttribute('aria-label', expect.stringMatching(/0 of 2 tasks/))
  })

  it('keeps collapse state across entries changes (mid-turn acp:plan_update)', () => {
    const { rerender } = render(
      <PlanPanel entries={[{ content: 'Task A', status: 'in_progress' }]} />
    )
    const toggle = screen.getByRole('button', { name: /Plan, 0 of 1 task, task in progress/ })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Simulate a mid-turn plan update: new entries arrive, collapse must persist
    rerender(
      <PlanPanel
        entries={[
          { content: 'Task A', status: 'completed' },
          { content: 'Task B', status: 'in_progress' }
        ]}
      />
    )
    // Panel stays collapsed — entries updated but user's choice preserved
    const updatedToggle = screen.getByRole('button', {
      name: /Plan, 1 of 2 tasks, task in progress/
    })
    expect(updatedToggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('hides the panel entirely when entries become empty (agent clears plan while collapsed)', async () => {
    const { rerender } = render(
      <PlanPanel entries={[{ content: 'Task A', status: 'in_progress' }]} />
    )
    const toggle = screen.getByRole('button', { name: /Plan, 0 of 1 task, task in progress/ })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Agent clears the plan (empty entries) — panel unmounts via AnimatePresence,
    // collapse state is irrelevant because entries.length === 0 always hides.
    rerender(<PlanPanel entries={[]} />)
    // AnimatePresence defers unmount until the exit animation completes; in jsdom
    // that flushes on the next microtask. Wait for the region to leave the DOM.
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Execution plan' })).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /Plan/ })).toBeNull()
  })

  it('exposes a11y attributes on the region and header toggle', () => {
    render(<PlanPanel entries={[{ content: 'Task A', status: 'completed' }]} />)
    const region = screen.getByRole('region', { name: 'Execution plan' })
    expect(region).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: /Plan, 1 of 1 task/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // aria-controls is a useId-generated dynamic id — just verify it exists and
    // matches the body's id.
    expect(toggle).toHaveAttribute('aria-controls')
    const controlsId = toggle.getAttribute('aria-controls')
    expect(controlsId).toBeTruthy()
    // useId generates ids with colons (e.g. ":rp:") which are invalid in CSS
    // selectors — use getElementById instead of querySelector('#...').
    expect(document.getElementById(controlsId!)).toBeInTheDocument()
  })

  it('keeps detail and status paired when entries reorder', async () => {
    function ReorderablePlan(): React.JSX.Element {
      const [entries, setEntries] = useState([
        { content: 'First task', detail: 'First detail', status: 'pending' },
        { content: 'Second task', detail: 'Second detail', status: 'completed' }
      ])

      return (
        <>
          <button type="button" onClick={() => setEntries([...entries].reverse())}>
            Reorder
          </button>
          <PlanPanel entries={entries} />
        </>
      )
    }

    render(<ReorderablePlan />)
    fireEvent.click(screen.getByRole('button', { name: 'Reorder' }))
    fireEvent.click(screen.getByRole('button', { name: /First task/ }))

    await waitFor(() => {
      expect(screen.getByText('First detail')).toBeVisible()
    })
    expect(screen.getByText('First task').parentElement).not.toHaveClass('line-through')
    expect(screen.getByText('Second task')).toHaveClass('line-through')
  })
})

describe('TermulPlanRenderer (termul-plan fence renderer)', () => {
  it('renders a read-only PlanPanel from valid fence JSON', () => {
    const code = JSON.stringify([
      { content: 'Read AC file', status: 'completed', priority: 'high' },
      { content: 'Fix bug', status: 'in_progress', priority: 'high' }
    ])
    render(<TermulPlanRenderer code={code} isIncomplete={false} language="termul-plan" />)
    // The renderer reuses PlanPanel, so the entries appear as plan rows
    expect(screen.getByRole('region', { name: 'Execution plan' })).toBeInTheDocument()
    expect(screen.getByText('Read AC file')).toBeInTheDocument()
    expect(screen.getByText('Fix bug')).toBeInTheDocument()
  })

  it('shows a fallback card when the fence JSON is malformed', () => {
    render(
      <TermulPlanRenderer code="{not valid json" isIncomplete={false} language="termul-plan" />
    )
    expect(screen.getByText('Plan snapshot unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Execution plan' })).toBeNull()
  })

  it('shows a streaming placeholder when the fence is incomplete', () => {
    render(<TermulPlanRenderer code="partial" isIncomplete={true} language="termul-plan" />)
    expect(screen.getByText('Plan snapshot incomplete')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Execution plan' })).toBeNull()
  })
})

describe('PlanPanel dock collapse (mobile dock)', () => {
  const entries = [
    { content: 'One', status: 'completed' },
    { content: 'Two', status: 'completed' },
    { content: 'Three', status: 'completed' },
    { content: 'Four', status: 'in_progress' },
    { content: 'Five', status: 'pending' }
  ]
  const bar = (): HTMLElement => screen.getByRole('button', { name: /^Plan, 3 of 5 tasks/ })

  it('starts as a collapsed "Plan 3/5" bar with defaultCollapsed, and a tap expands it in place', async () => {
    render(<PlanPanel entries={entries} defaultCollapsed />)

    expect(bar()).toHaveAttribute('aria-expanded', 'false')
    expect(bar()).toHaveTextContent('Plan')
    expect(bar()).toHaveTextContent('3/5')
    expect(screen.queryByText('One')).toBeNull()

    fireEvent.click(bar())
    expect(bar()).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('One')).toBeInTheDocument()
  })

  it('stays expanded by default (desktop and the inline plan fence)', () => {
    render(<PlanPanel entries={entries} />)
    expect(bar()).toHaveAttribute('aria-expanded', 'true')
  })

  it('renders collapsed while forceCollapsed, then returns to the user state', () => {
    const { rerender } = render(<PlanPanel entries={entries} />)
    expect(bar()).toHaveAttribute('aria-expanded', 'true')

    rerender(<PlanPanel entries={entries} forceCollapsed />)
    expect(bar()).toHaveAttribute('aria-expanded', 'false')

    rerender(<PlanPanel entries={entries} forceCollapsed={false} />)
    expect(bar()).toHaveAttribute('aria-expanded', 'true')
  })

  it('lets a header tap flip the rendered state during the force window', () => {
    const { rerender } = render(<PlanPanel entries={entries} defaultCollapsed forceCollapsed />)
    expect(bar()).toHaveAttribute('aria-expanded', 'false')

    // Tapping a force-collapsed bar expands it, and that sticks while forced.
    fireEvent.click(bar())
    expect(bar()).toHaveAttribute('aria-expanded', 'true')
    rerender(<PlanPanel entries={entries} defaultCollapsed forceCollapsed />)
    expect(bar()).toHaveAttribute('aria-expanded', 'true')

    // Tapping again collapses it.
    fireEvent.click(bar())
    expect(bar()).toHaveAttribute('aria-expanded', 'false')

    // The window ends: the bar shows the user's last own state (collapsed).
    rerender(<PlanPanel entries={entries} defaultCollapsed forceCollapsed={false} />)
    expect(bar()).toHaveAttribute('aria-expanded', 'false')
  })

  it("keeps the user's tap after the window ends and re-forces on the next window", () => {
    const { rerender } = render(<PlanPanel entries={entries} defaultCollapsed forceCollapsed />)
    fireEvent.click(bar())
    expect(bar()).toHaveAttribute('aria-expanded', 'true')

    rerender(<PlanPanel entries={entries} defaultCollapsed forceCollapsed={false} />)
    expect(bar()).toHaveAttribute('aria-expanded', 'true')

    // The mark reset when the window ended, so a new window collapses again.
    rerender(<PlanPanel entries={entries} defaultCollapsed forceCollapsed />)
    expect(bar()).toHaveAttribute('aria-expanded', 'false')
  })

  it('does not record a tap made outside the force window', () => {
    const { rerender } = render(<PlanPanel entries={entries} />)
    fireEvent.click(bar())
    expect(bar()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(bar())
    expect(bar()).toHaveAttribute('aria-expanded', 'true')

    // Had that tap been marked as made during a window, this would not force.
    rerender(<PlanPanel entries={entries} forceCollapsed />)
    expect(bar()).toHaveAttribute('aria-expanded', 'false')
  })
})
