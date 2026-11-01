import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { framerMotionTestState, resetFramerMotionTestState } from '@/test-utils/mock-framer-motion'
import {
  MobileSheetContent,
  SheetGroup,
  SheetRow,
  SheetSwitchRow,
  useSheetStack
} from './mobile-sheet'
import { Sheet, SheetTrigger } from './sheet'

vi.mock('framer-motion', async (importOriginal) => {
  const { installFramerMotionMock } = await import('@/test-utils/mock-framer-motion')
  return installFramerMotionMock(importOriginal)
})

beforeEach(() => resetFramerMotionTestState())

afterEach(() => {
  cleanup()
  useOverlayStackStore.setState({ stack: [] })
})

type Route = { kind: 'effort' } | { kind: 'level'; name: string }

const keyOf = (route: Route): string => (route.kind === 'effort' ? 'effort' : `level:${route.name}`)

function Harness({ onFast }: { onFast?: (on: boolean) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [fast, setFast] = useState(false)
  const nav = useSheetStack<Route>('harness', open, keyOf)
  const top = nav.top
  const title =
    top?.kind === 'effort' ? 'Effort' : top?.kind === 'level' ? top.name : 'Select model'
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger>Open</SheetTrigger>
      <MobileSheetContent
        title={title}
        nav={nav}
        aria-describedby={undefined}
        onEscapeKeyDown={nav.onEscapeKeyDown}
      >
        {top?.kind === 'level' ? (
          <p>{`About ${top.name}`}</p>
        ) : top?.kind === 'effort' ? (
          <div role="radiogroup" aria-label="Effort">
            <SheetGroup>
              <SheetRow
                title="Low"
                accessory="check"
                role="radio"
                selected={false}
                onSelect={nav.pop}
              />
              <SheetRow title="High" accessory="check" role="radio" selected onSelect={nav.pop} />
              <SheetRow
                title="About High"
                accessory="chevron"
                subview="level:High"
                onSelect={() => nav.push({ kind: 'level', name: 'High' })}
              />
            </SheetGroup>
          </div>
        ) : (
          <SheetGroup label="Options">
            <SheetRow
              title="Effort"
              value="High"
              accessory="chevron"
              subview="effort"
              onSelect={() => nav.push({ kind: 'effort' })}
            />
            <SheetSwitchRow
              title="Fast"
              checked={fast}
              onCheckedChange={(next) => {
                setFast(next)
                onFast?.(next)
              }}
            />
            <SheetRow title="Usage" subtitle="5-hour limit" value="12%" />
          </SheetGroup>
        )}
      </MobileSheetContent>
    </Sheet>
  )
}

function openSheet(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  return screen.getByRole('dialog', { name: 'Select model' })
}

describe('MobileSheetContent', () => {
  it('shows one Close button on the left of a centred title and closes the sheet with it', () => {
    render(<Harness />)
    const sheet = openSheet()

    expect(within(sheet).getAllByRole('button', { name: 'Close' })).toHaveLength(1)
    expect(within(sheet).getByRole('heading', { name: 'Select model' })).toBeInTheDocument()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names the group and its rows, with the value and switch reachable by role', () => {
    const onFast = vi.fn()
    render(<Harness onFast={onFast} />)
    const sheet = openSheet()

    const group = within(sheet).getByRole('group', { name: 'Options' })
    expect(within(group).getByRole('button', { name: 'Effort High' })).toBeInTheDocument()
    expect(within(group).getByText('5-hour limit')).toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: /Usage/ })).toBeNull()

    fireEvent.click(within(group).getByRole('switch', { name: 'Fast' }))
    expect(onFast).toHaveBeenCalledWith(true)
  })

  it('opens a sub-view with Back, focuses Back, and returns focus to its row', async () => {
    render(<Harness />)
    const sheet = openSheet()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Effort High' }))
    const back = within(sheet).getByRole('button', { name: 'Back' })
    expect(within(sheet).getByRole('heading', { name: 'Effort' })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Close' })).toBeNull()
    expect(within(sheet).getByRole('radio', { name: 'High' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await waitFor(() => expect(back).toHaveFocus())

    fireEvent.click(back)
    await waitFor(() =>
      expect(within(sheet).getByRole('button', { name: 'Effort High' })).toHaveFocus()
    )
  })

  it('Escape leaves the sub-view first, then closes the sheet', () => {
    render(<Harness />)
    const sheet = openSheet()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Effort High' }))

    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Select model' })).toBeInTheDocument()

    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('system back leaves the sub-view before anything below it', () => {
    render(<Harness />)
    const sheet = openSheet()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Effort High' }))
    expect(useOverlayStackStore.getState().stack.map((entry) => entry.id)).toEqual([
      'harness:subview:1'
    ])

    act(() => {
      expect(useOverlayStackStore.getState().closeTopmostOverlay()).toBe(true)
    })

    expect(screen.getByRole('dialog', { name: 'Select model' })).toBeInTheDocument()
    expect(useOverlayStackStore.getState().stack).toEqual([])
  })

  it('pushes two levels and pops one per Escape, system back, or Back', async () => {
    render(<Harness />)
    const sheet = openSheet()
    const ids = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

    fireEvent.click(within(sheet).getByRole('button', { name: 'Effort High' }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'About High' }))
    expect(within(sheet).getByRole('heading', { name: 'High' })).toBeInTheDocument()
    expect(ids()).toEqual(['harness:subview:1', 'harness:subview:2'])

    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(within(sheet).getByRole('heading', { name: 'Effort' })).toBeInTheDocument()
    expect(ids()).toEqual(['harness:subview:1'])
    await waitFor(() =>
      expect(within(sheet).getByRole('button', { name: 'About High' })).toHaveFocus()
    )

    fireEvent.click(within(sheet).getByRole('button', { name: 'About High' }))
    act(() => {
      useOverlayStackStore.getState().closeTopmostOverlay()
    })
    expect(within(sheet).getByRole('heading', { name: 'Effort' })).toBeInTheDocument()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Back' }))
    expect(within(sheet).getByRole('heading', { name: 'Select model' })).toBeInTheDocument()
    expect(ids()).toEqual([])
  })

  it('keeps the view it leaves on screen, inert, until the slide ends', async () => {
    render(<Harness />)
    const sheet = openSheet()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Effort High' }))
    const leaving = within(sheet).getByText('Fast').closest('[inert]')
    expect(leaving).toHaveAttribute('aria-hidden', 'true')
    expect(within(sheet).queryByRole('switch', { name: 'Fast' })).toBeNull()
    await waitFor(() => expect(within(sheet).queryByText('Fast')).toBeNull())
  })

  it('slides a pushed view in from the right and a popped one back from 30% left', async () => {
    render(<Harness />)
    const sheet = openSheet()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Effort High' }))
    const pushed = within(sheet).getByRole('radiogroup', { name: 'Effort' }).parentElement
      ?.parentElement as HTMLElement
    expect(pushed.style.transform).toBe('translateX(100%)')
    await waitFor(() => expect(within(sheet).queryByText('Fast')).toBeNull())

    fireEvent.click(within(sheet).getByRole('button', { name: 'Back' }))
    const root = within(sheet).getByRole('group', { name: 'Options' }).parentElement
      ?.parentElement as HTMLElement
    expect(root.style.transform).toBe('translateX(-30%)')
  })

  it('fades views instead of sliding them under reduced motion', () => {
    framerMotionTestState.reducedMotion.current = true
    render(<Harness />)
    const sheet = openSheet()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Effort High' }))
    const pushed = within(sheet).getByRole('radiogroup', { name: 'Effort' }).parentElement
      ?.parentElement as HTMLElement
    expect(pushed.style.transform).toBe('')
    expect(pushed.style.opacity).toBe('0')
  })
})
