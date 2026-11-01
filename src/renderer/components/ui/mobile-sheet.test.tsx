import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import {
  MobileSheetContent,
  SheetGroup,
  SheetRow,
  SheetSwitchRow,
  useSheetSubview
} from './mobile-sheet'
import { Sheet, SheetTrigger } from './sheet'

afterEach(() => {
  cleanup()
  useOverlayStackStore.setState({ stack: [] })
})

function Harness({ onFast }: { onFast?: (on: boolean) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [fast, setFast] = useState(false)
  const sub = useSheetSubview<'effort'>('harness', open)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger>Open</SheetTrigger>
      <MobileSheetContent
        title={sub.view === 'effort' ? 'Effort' : 'Select model'}
        onBack={sub.view ? sub.back : undefined}
        view={sub.view}
        aria-describedby={undefined}
        onEscapeKeyDown={sub.onEscapeKeyDown}
      >
        {sub.view === 'effort' ? (
          <div role="radiogroup" aria-label="Effort">
            <SheetGroup>
              <SheetRow
                title="Low"
                accessory="check"
                role="radio"
                selected={false}
                onSelect={sub.back}
              />
              <SheetRow title="High" accessory="check" role="radio" selected onSelect={sub.back} />
            </SheetGroup>
          </div>
        ) : (
          <SheetGroup label="Options">
            <SheetRow
              title="Effort"
              value="High"
              accessory="chevron"
              subview="effort"
              onSelect={() => sub.open('effort')}
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
      'harness:subview'
    ])

    act(() => {
      expect(useOverlayStackStore.getState().closeTopmostOverlay()).toBe(true)
    })

    expect(screen.getByRole('dialog', { name: 'Select model' })).toBeInTheDocument()
    expect(useOverlayStackStore.getState().stack).toEqual([])
  })
})
