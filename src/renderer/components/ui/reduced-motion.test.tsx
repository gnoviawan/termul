import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle
} from './alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card'
import { ImageLightbox } from './image-lightbox'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'
import { Toast, ToastProvider, ToastTitle, ToastViewport } from './toast'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

/**
 * The animated Radix primitives skip their entry and exit animation under
 * reduced motion. The token is important on purpose: `data-[state=open]:animate-in`
 * compiles to `.cls[data-state="open"]`, which outranks a bare
 * `motion-reduce:animate-none`. jsdom evaluates no media query, so the rule is
 * asserted as a class token, beside the animation classes it overrides.
 */
const REDUCED = 'motion-reduce:animate-none!'
const OPEN = 'data-[state=open]:animate-in'
const CLOSED = 'data-[state=closed]:animate-out'

function tokens(element: Element | null | undefined): string[] {
  expect(element).toBeTruthy()
  return (element?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
}

function expectReducedMotion(element: Element | null | undefined): void {
  const list = tokens(element)
  expect(list).toContain(REDUCED)
  // The animation itself is untouched for everyone else.
  expect(list).toContain(OPEN)
  expect(list).toContain(CLOSED)
}

beforeAll(() => {
  // Radix Select measures and scrolls its items on open; jsdom implements
  // neither pointer capture nor scrollIntoView.
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => {}
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
})

describe('reduced motion on animated primitives', () => {
  it('alert-dialog: the overlay and the content', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Delete file</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>
    )

    const content = screen.getByRole('alertdialog')
    expectReducedMotion(content)
    expect(tokens(content)).toContain('data-[state=open]:zoom-in-95')

    const overlay = document.querySelector('[class*="bg-overlay/80"]')
    expectReducedMotion(overlay)
    expect(tokens(overlay)).toContain('data-[state=open]:fade-in-0')
  })

  it('dropdown-menu: the content and the sub-content', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>One</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    const menus = screen.getAllByRole('menu')
    expect(menus).toHaveLength(2)
    for (const menu of menus) expectReducedMotion(menu)
    // The nested menu is the sub-content: the one that holds the nested item.
    const sub = screen.getByText('Nested').closest('[role="menu"]')
    expect(sub).not.toBe(screen.getByText('One').closest('[role="menu"]'))
    expectReducedMotion(sub)
  })

  it('popover: the content', () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Popover body</PopoverContent>
      </Popover>
    )

    expectReducedMotion(screen.getByText('Popover body'))
  })

  it('select: the content', () => {
    render(
      <Select open value="a">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
          <SelectItem value="b">Beta</SelectItem>
        </SelectContent>
      </Select>
    )

    expectReducedMotion(screen.getByRole('listbox'))
  })

  it('hover-card: the content', () => {
    render(
      <HoverCard open>
        <HoverCardTrigger>Hover</HoverCardTrigger>
        <HoverCardContent>Card body</HoverCardContent>
      </HoverCard>
    )

    expectReducedMotion(screen.getByText('Card body'))
  })

  it('toast: the root', () => {
    render(
      <ToastProvider>
        <Toast open>
          <ToastTitle>Saved</ToastTitle>
        </Toast>
        <ToastViewport />
      </ToastProvider>
    )

    const toast = screen.getByText('Saved').closest('[data-state="open"]')
    expectReducedMotion(toast)
    expect(tokens(toast)).toContain('data-[swipe=end]:animate-out')
  })

  it('image-lightbox: the overlay and the content', () => {
    render(
      <ImageLightbox src="/full.png" alt="Diagram">
        <img src="/thumb.png" alt="Diagram" />
      </ImageLightbox>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open image: Diagram' }))

    const overlay = document.querySelector('[class*="bg-overlay/85"]')
    expectReducedMotion(overlay)
    expect(tokens(overlay)).toContain('data-[state=open]:fade-in-0')

    const content = screen.getByRole('dialog')
    expectReducedMotion(content)
    expect(tokens(content)).toContain('data-[state=open]:zoom-in-95')
  })
})
