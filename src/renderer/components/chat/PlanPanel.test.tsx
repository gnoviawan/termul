import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanPanel } from './PlanPanel'

describe('PlanPanel', () => {
  it('splits task names from direct and metadata details in expandable rows', () => {
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
    expect(screen.getByText('Use the existing primitives for the task details.')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /Run checks/ }))
    expect(screen.getByText('Run the focused renderer tests.')).toBeVisible()
  })

  it('keeps entries without detail as simple rows', () => {
    render(<PlanPanel entries={[{ content: 'No detail', status: 'completed' }]} />)

    expect(screen.getByText('No detail')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /No detail/ })).toBeNull()
    expect(screen.getByText('No detail')).toHaveClass('line-through')
  })

  it('bounds long plans and updates status while the panel is live', () => {
    const { container, rerender } = render(
      <PlanPanel entries={Array.from({ length: 20 }, (_, i) => ({ content: `Task ${i}` }))} />
    )

    expect(container.querySelector('.max-h-60')).toBeInTheDocument()

    rerender(<PlanPanel entries={[{ content: 'Task 0', status: 'completed' }]} />)
    expect(screen.getByText('Task 0')).toHaveClass('line-through')
  })
})
