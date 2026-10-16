import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetNativeWebviewOcclusionForTests,
  useNativeWebviewOccluded
} from '@/hooks/use-native-webview-occlusion'
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from './alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from './context-menu'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './dropdown-menu'
import { ImageLightbox } from './image-lightbox'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'
import { Sheet, SheetContent, SheetTitle } from './sheet'

vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri-runtime')>()),
  isTauriContext: () => true
}))

// Radix Select and menus call pointer-capture and scroll APIs jsdom lacks.
for (const name of ['hasPointerCapture', 'releasePointerCapture', 'scrollIntoView'] as const) {
  if (typeof Element.prototype[name] !== 'function') {
    Object.defineProperty(Element.prototype, name, { value: () => false, configurable: true })
  }
}

function Occluded(): React.JSX.Element {
  return <span data-testid="occluded">{String(useNativeWebviewOccluded())}</span>
}

const occluded = (): string | null => screen.getByTestId('occluded').textContent

const controlled: Array<[string, (open: boolean) => React.JSX.Element]> = [
  [
    'Dialog',
    (open) => (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Rename</DialogTitle>
        </DialogContent>
      </Dialog>
    )
  ],
  [
    'AlertDialog',
    (open) => (
      <AlertDialog open={open} onOpenChange={() => {}}>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogTitle>Delete?</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>
    )
  ],
  [
    'Sheet',
    (open) => (
      <Sheet open={open}>
        <SheetContent aria-describedby={undefined}>
          <SheetTitle>Settings</SheetTitle>
        </SheetContent>
      </Sheet>
    )
  ],
  [
    'Popover',
    (open) => (
      <Popover open={open}>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>
    )
  ],
  [
    'DropdownMenu',
    (open) => (
      <DropdownMenu open={open}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Close tab</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  ],
  [
    'Select',
    (open) => (
      <Select open={open} value="a">
        <SelectTrigger aria-label="Pick">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>
    )
  ]
]

describe('shared overlay primitives occlude native webviews while open', () => {
  afterEach(() => {
    cleanup()
    resetNativeWebviewOcclusionForTests()
  })

  it.each(controlled)('%s', async (_name, overlay) => {
    const view = render(
      <>
        {overlay(false)}
        <Occluded />
      </>
    )
    expect(occluded()).toBe('false')

    view.rerender(
      <>
        {overlay(true)}
        <Occluded />
      </>
    )
    await waitFor(() => expect(occluded()).toBe('true'))

    view.rerender(
      <>
        {overlay(false)}
        <Occluded />
      </>
    )
    await waitFor(() => expect(occluded()).toBe('false'))
  })

  it('ContextMenu', async () => {
    render(
      <>
        <ContextMenu>
          <ContextMenuTrigger>Tab</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Close</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <Occluded />
      </>
    )
    expect(occluded()).toBe('false')

    fireEvent.contextMenu(screen.getByText('Tab'))
    await screen.findByRole('menu')
    await waitFor(() => expect(occluded()).toBe('true'))

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(occluded()).toBe('false'))
  })

  it('ImageLightbox', async () => {
    render(
      <>
        <ImageLightbox src="/shot.png" alt="Screenshot">
          <img src="/thumb.png" alt="" />
        </ImageLightbox>
        <Occluded />
      </>
    )
    expect(occluded()).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Open image: Screenshot' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect(occluded()).toBe('true'))

    fireEvent.click(screen.getByRole('button', { name: 'Close image' }))
    await waitFor(() => expect(occluded()).toBe('false'))
  })
})
