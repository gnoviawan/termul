import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

function renderDialog(): void {
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Dialog title</DialogTitle>
        <DialogDescription>Dialog description</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

describe('Dialog built-in close', () => {
  it('grows to 44px on coarse pointers and keeps its fine-pointer position', () => {
    renderDialog()
    const classes = screen.getByRole('button', { name: 'Close' }).className.split(/\s+/)

    expect(classes).toContain('pointer-coarse:size-11')
    expect(classes).toEqual(expect.arrayContaining(['right-4', 'top-4']))
    expect(classes).toEqual(
      expect.arrayContaining(['pointer-coarse:right-0.5', 'pointer-coarse:top-0.5'])
    )
  })

  it('centres the glyph in the coarse box only, so fine pointers render as before', () => {
    renderDialog()
    const classes = screen.getByRole('button', { name: 'Close' }).className.split(/\s+/)

    expect(classes).toEqual(
      expect.arrayContaining([
        'pointer-coarse:flex',
        'pointer-coarse:items-center',
        'pointer-coarse:justify-center'
      ])
    )
    // No fine-pointer sizing or display class: those would change desktop.
    const fine = classes.filter((cls) => !cls.includes(':'))
    expect(fine.some((cls) => /^(size|w|h)-/.test(cls))).toBe(false)
    expect(fine).not.toContain('flex')
    expect(fine).not.toContain('inline-flex')
    expect(fine).toEqual(
      expect.arrayContaining([
        'absolute',
        'right-4',
        'top-4',
        'rounded-lg',
        'opacity-70',
        'transition-opacity',
        'ring-offset-background'
      ])
    )
  })

  it('keeps the 16px glyph and the sr-only "Close" name', () => {
    renderDialog()
    const button = screen.getByRole('button', { name: 'Close' })

    expect(button.querySelector('svg')?.getAttribute('class')).toContain('h-4')
    expect(button.querySelector('.sr-only')?.textContent).toBe('Close')
  })
})

describe('Dialog reduced motion', () => {
  // The important modifier is deliberate: `data-[state=open]:animate-in`
  // outranks a bare `motion-reduce:animate-none`.
  it('skips the content and overlay animation under reduced motion', () => {
    renderDialog()
    const content = screen.getByRole('dialog')
    const overlay = document.body.querySelector('div.fixed.inset-0')

    expect(content.className).toContain('motion-reduce:animate-none!')
    expect(content.className).toContain('data-[state=open]:animate-in')
    expect(overlay).not.toBeNull()
    expect(overlay?.className).toContain('motion-reduce:animate-none!')
    expect(overlay?.className).toContain('data-[state=open]:animate-in')
  })
})
