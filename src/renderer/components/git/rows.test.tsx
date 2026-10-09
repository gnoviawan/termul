import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChangesFilter, FileItem, GitStatusLetter, SectionHeader } from './rows'

describe('git rows', () => {
  const file = { path: 'src/a.ts', status: 'modified' as const }

  it('open-diff row is the keycap, not a primary wash', () => {
    render(<FileItem file={file} isActive isSelected={false} onClick={vi.fn()} />)
    const row = screen.getByRole('option')
    expect(row.className).toContain('keycap')
    expect(row.className).toContain('text-foreground')
    expect(row.className).not.toMatch(/bg-primary|bg-secondary|bg-accent/)
  })

  it('multi-selected row uses the neutral 6% wash; idle rows hover at 3%', () => {
    const { rerender } = render(
      <FileItem file={file} isActive={false} isSelected onClick={vi.fn()} />
    )
    expect(screen.getByRole('option').className).toContain('bg-foreground/[0.06]')
    rerender(<FileItem file={file} isActive={false} isSelected={false} onClick={vi.fn()} />)
    const idle = screen.getByRole('option').className
    expect(idle).toContain('hover:bg-foreground/[0.03]')
    expect(idle).toContain('text-secondary-foreground')
    expect(idle).not.toContain('keycap')
  })

  it('status letters use diff tokens', () => {
    const { rerender } = render(<GitStatusLetter status="modified" />)
    expect(screen.getByRole('img', { name: /modified/i }).className).toContain('text-diff-modified')
    rerender(<GitStatusLetter status="deleted" />)
    expect(screen.getByRole('img').className).toContain('text-destructive')
    rerender(<GitStatusLetter status="untracked" />)
    expect(screen.getByRole('img').textContent).toBe('U')
    expect(screen.getByRole('img').className).toContain('text-diff-added')
  })

  it('section header uses the panel label and a tabular count', () => {
    render(<SectionHeader label="Changes" count={3} selectionCount={0} />)
    expect(screen.getByText('Changes').className).toContain('label-panel')
    expect(screen.getByText('3').className).toContain('tabular-nums')
  })

  it('filter is the shared field with a neutral focus border', () => {
    render(<ChangesFilter value="" onChange={vi.fn()} />)
    const input = screen.getByPlaceholderText('Filter changes')
    expect(input.className).toContain('h-8')
    expect(input.className).toContain('bg-card')
    expect(input.className).toContain('focus:border-muted-foreground/60')
    expect(input.className).not.toContain('ring-primary')
  })
})
