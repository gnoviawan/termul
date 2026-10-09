import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next)
        setOpen(next)
      }}
    >
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Details</DialogTitle>
        <DialogDescription>Body</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

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

  it('drops the ring offset on coarse pointers so the ring stays on screen', () => {
    renderDialog()
    const classes = screen.getByRole('button', { name: 'Close' }).className.split(/\s+/)

    // The dialog is `w-full`, so on a phone the 44px box sits 2px from the
    // viewport edge: a 2px offset plus a 2px ring would be painted entirely
    // past it. Fine pointers keep the offset.
    expect(classes).toContain('pointer-coarse:focus:ring-offset-0')
    expect(classes).toContain('focus:ring-offset-2')
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

function stackIds(): string[] {
  return useOverlayStackStore.getState().stack.map((entry) => entry.id)
}

describe('ui/dialog overlay back stack', () => {
  let cleanup: () => void

  beforeEach(() => {
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('mobile shell', () => {
    it('registers while open, and system back removes the dialog and consumes the sentinel', async () => {
      const onOpenChange = vi.fn()
      render(<Harness onOpenChange={onOpenChange} />)

      fireEvent.click(screen.getByText('Open dialog'))
      expect(screen.getByRole('dialog', { name: 'Details' })).toBeInTheDocument()
      expect(stackIds()).toHaveLength(1)
      expect(stackIds()[0]).toMatch(/^dialog:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(onOpenChange).toHaveBeenLastCalledWith(false)
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a close by the X button consumes the sentinel so the next back is not dead', async () => {
      render(<Harness />)
      fireEvent.click(screen.getByText('Open dialog'))
      await waitForSentinelDepth(1)
      const backSpy = vi.spyOn(history, 'back')

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await waitForSentinelDepth(0)
      expect(backSpy).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(location.hash).toBe('#/base')
    })

    it('a close by Esc consumes the sentinel and closes exactly once', async () => {
      const onOpenChange = vi.fn()
      render(<Harness onOpenChange={onOpenChange} />)
      fireEvent.click(screen.getByText('Open dialog'))
      await waitForSentinelDepth(1)

      fireEvent.keyDown(document.body, { key: 'Escape' })

      await waitForSentinelDepth(0)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(onOpenChange.mock.calls.filter(([next]) => next === false)).toHaveLength(1)
    })
  })

  describe('desktop shell', () => {
    it('is inert: no registration, no history push and no traversal', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      render(<Harness />)

      fireEvent.click(screen.getByText('Open dialog'))
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(stackIds()).toEqual([])
      fireEvent.keyDown(document.body, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await settleOverlayBackStack()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })

  it('stays uncontrolled-compatible: a Dialog without `open` is never registered', () => {
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>
    )

    fireEvent.click(screen.getByText('Open'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(stackIds()).toEqual([])
  })
})
