import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'

function renderSheet(side: 'top' | 'bottom' | 'left' | 'right' = 'bottom'): void {
  render(
    <Sheet open>
      <SheetContent side={side}>
        <SheetTitle>Sheet title</SheetTitle>
        <SheetDescription>Sheet description</SheetDescription>
      </SheetContent>
    </Sheet>
  )
}

function closeButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Close' })
}

function overlay(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('div[data-state="open"][class*="bg-overlay"]')
  if (!el) throw new Error('sheet overlay not found')
  return el
}

describe('Sheet built-in close', () => {
  it('is a 28px box that grows to 44px on coarse pointers', () => {
    renderSheet()
    const classes = closeButton().className.split(/\s+/)

    expect(classes).toContain('size-7')
    expect(classes).toContain('pointer-coarse:size-11')
  })

  it('centres its glyph in the box and keeps the glyph 24px from the corner', () => {
    renderSheet()
    const classes = closeButton().className.split(/\s+/)

    // A 28px box at 10px (right-2.5/top-2.5) and a 44px box at 2px
    // (right-0.5/top-0.5) both centre the 16px glyph 24px from the corner,
    // where right-4/top-4 put it before.
    expect(classes).toEqual(expect.arrayContaining(['right-2.5', 'top-2.5']))
    expect(classes).toEqual(
      expect.arrayContaining(['pointer-coarse:right-0.5', 'pointer-coarse:top-0.5'])
    )
    expect(classes).toEqual(expect.arrayContaining(['flex', 'items-center', 'justify-center']))
    expect(classes).not.toContain('right-4')
    expect(classes).not.toContain('top-4')
  })

  it('keeps the 16px glyph and the sr-only "Close" name, with no second close', () => {
    renderSheet()
    const button = closeButton()
    const glyph = button.querySelector('svg')

    expect(glyph?.getAttribute('class')).toContain('h-4')
    expect(glyph?.getAttribute('class')).toContain('w-4')
    expect(button.querySelector('.sr-only')?.textContent).toBe('Close')
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1)
  })

  it('drops the ring offset on coarse pointers so the ring stays on screen', () => {
    renderSheet('right')
    const classes = closeButton().className.split(/\s+/)

    // The 44px box sits 2px from the viewport edge, so a 2px offset plus a 2px
    // ring would be painted entirely past it. Fine pointers keep the offset.
    expect(classes).toContain('pointer-coarse:focus:ring-offset-0')
    expect(classes).toContain('focus:ring-offset-2')
  })

  it('keeps the focus ring and the other visual classes', () => {
    renderSheet()
    const classes = closeButton().className.split(/\s+/)

    expect(classes).toEqual(
      expect.arrayContaining([
        'absolute',
        'rounded-sm',
        'opacity-70',
        'hover:opacity-100',
        'focus:ring-2',
        'focus:ring-ring'
      ])
    )
  })
})

describe('Sheet reduced motion', () => {
  it('skips the content animation with an important motion-reduce class', () => {
    renderSheet()
    const content = document.querySelector('[data-sheet]')

    expect(content?.className).toContain('motion-reduce:animate-none!')
    // The entry animation itself is untouched for everyone else.
    expect(content?.className).toContain('data-[state=open]:animate-in')
  })

  it('skips the overlay animation too', () => {
    renderSheet()

    expect(overlay().className).toContain('motion-reduce:animate-none!')
    expect(overlay().className).toContain('data-[state=open]:animate-in')
    expect(overlay().className).toContain('bg-overlay/80')
  })

  it.each(['top', 'bottom', 'left', 'right'] as const)('applies to the %s side', (side) => {
    renderSheet(side)

    expect(document.querySelector('[data-sheet]')?.className).toContain(
      'motion-reduce:animate-none!'
    )
  })
})
