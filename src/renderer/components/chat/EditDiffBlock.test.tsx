import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { COLLAPSED_ROWS, EditDiffBlock } from './EditDiffBlock'

const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)

function editAt(index: number): { path: string; oldText: string; newText: string } {
  const edited = [...base]
  edited[index] = 'changed'
  return { path: '/repo/src/lib.rs', oldText: base.join('\n'), newText: edited.join('\n') }
}

function rows(container: HTMLElement): string[] {
  const body = container.querySelector('[data-diff-rows]')
  return [...(body?.children ?? [])].map((row) => row.lastElementChild?.textContent ?? '')
}

describe('EditDiffBlock', () => {
  it('shows the file name and change counts in the header', () => {
    render(<EditDiffBlock diff={editAt(9)} />)

    expect(screen.getByText('lib.rs')).toHaveAttribute('title', '/repo/src/lib.rs')
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText(/−1/)).toBeInTheDocument()
  })

  it('collapses to a few rows that start just before the first change', () => {
    const { container } = render(<EditDiffBlock diff={editAt(9)} />)

    expect(container.querySelector('[data-diff-rows]')).toHaveAttribute(
      'data-diff-rows',
      'collapsed'
    )
    expect(rows(container)).toHaveLength(COLLAPSED_ROWS)
    expect(rows(container)[0]).toBe('line 9')
    expect(rows(container)).toContain('changed')
  })

  it('expands to the full diff on click', () => {
    const { container } = render(<EditDiffBlock diff={editAt(9)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show full diff of lib.rs' }))

    expect(container.querySelector('[data-diff-rows]')).toHaveAttribute(
      'data-diff-rows',
      'expanded'
    )
    expect(rows(container)).toEqual([
      'line 7',
      'line 8',
      'line 9',
      'line 10',
      'changed',
      'line 11',
      'line 12',
      'line 13'
    ])
    expect(screen.queryByRole('button', { name: /show full diff/i })).not.toBeInTheDocument()
  })

  it('does not offer expansion when every row already fits', () => {
    const { container } = render(
      <EditDiffBlock diff={{ path: 'a.ts', oldText: null, newText: 'one\ntwo' }} />
    )

    expect(rows(container)).toEqual(['one', 'two'])
    expect(screen.queryByRole('button', { name: /show full diff/i })).not.toBeInTheDocument()
  })

  it('opens the file at the first changed line from the header', () => {
    const onOpenFile = vi.fn()
    render(<EditDiffBlock diff={editAt(9)} onOpenFile={onOpenFile} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open lib.rs at line 10' }))

    expect(onOpenFile).toHaveBeenCalledWith('/repo/src/lib.rs', 10)
  })

  it('keeps the header static without an open handler', () => {
    render(<EditDiffBlock diff={editAt(9)} />)

    expect(screen.queryByRole('button', { name: /^open/i })).not.toBeInTheDocument()
  })
})
