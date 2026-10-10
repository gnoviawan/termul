import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { type RenameFocusReturn, useRenameFocusReturn } from './use-rename-focus-return'

interface HarnessProps {
  open?: boolean
  folder?: string | null
  rows?: string[]
  onReady?: (api: RenameFocusReturn) => void
}

/** A stand-in for the Files sheet: a focusable content element, rows, and one other control. */
function Harness({
  open = true,
  folder = '/proj',
  rows = ['a'],
  onReady
}: HarnessProps): React.JSX.Element {
  const sheetRef = useRef<HTMLDivElement>(null)
  const api = useRenameFocusReturn(sheetRef, open, folder)
  onReady?.(api)
  return (
    <div ref={sheetRef} data-testid="sheet" tabIndex={-1}>
      <button type="button">other control</button>
      {rows.map((key) => (
        <button key={key} type="button" ref={api.registerActionsButton(key)}>
          actions {key}
        </button>
      ))}
    </div>
  )
}

function renderHarness(props: HarnessProps = {}) {
  let api: RenameFocusReturn | undefined
  const onReady = (next: RenameFocusReturn): void => {
    api = next
  }
  const view = render(<Harness {...props} onReady={onReady} />)
  return {
    api: (): RenameFocusReturn => {
      if (!api) throw new Error('hook never rendered')
      return api
    },
    rerender: (next: HarnessProps) => view.rerender(<Harness {...next} onReady={onReady} />)
  }
}

describe('useRenameFocusReturn', () => {
  beforeEach(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
  })

  it('focuses a mounted Actions button at once while focus is on <body>', () => {
    const { api } = renderHarness()

    act(() => api().focusActionsButton('a'))

    expect(screen.getByText('actions a')).toHaveFocus()
  })

  it('treats the sheet content element as lost focus', () => {
    const { api } = renderHarness()
    act(() => screen.getByTestId('sheet').focus())

    act(() => api().focusActionsButton('a'))

    expect(screen.getByText('actions a')).toHaveFocus()
  })

  it('never takes focus the user moved to another control', () => {
    const { api } = renderHarness()
    act(() => screen.getByText('other control').focus())

    act(() => api().focusActionsButton('a'))

    expect(screen.getByText('other control')).toHaveFocus()
  })

  it('waits for the row to mount, then focuses its button', () => {
    const { api, rerender } = renderHarness({ rows: [] })

    act(() => api().focusActionsButton('b'))
    expect(document.body).toHaveFocus()

    rerender({ rows: ['b'] })

    expect(screen.getByText('actions b')).toHaveFocus()
  })

  it('does not take focus the user moved while it waited for the row', () => {
    const { api, rerender } = renderHarness({ rows: [] })
    act(() => api().focusActionsButton('b'))
    act(() => screen.getByText('other control').focus())

    rerender({ rows: ['b'] })

    expect(screen.getByText('other control')).toHaveFocus()
  })

  it('is consumed once: a later remount of the button does not take focus again', () => {
    const { api, rerender } = renderHarness({ rows: [] })
    act(() => api().focusActionsButton('b'))
    rerender({ rows: ['b'] })
    expect(screen.getByText('actions b')).toHaveFocus()

    act(() => screen.getByText('other control').focus())
    rerender({ rows: [] })
    rerender({ rows: ['b'] })

    expect(screen.getByText('other control')).toHaveFocus()
  })

  it('drops a pending return when the folder changes', () => {
    const { api, rerender } = renderHarness({ rows: [] })
    act(() => api().focusActionsButton('b'))

    rerender({ rows: [], folder: '/proj/sub' })
    rerender({ rows: ['b'], folder: '/proj/sub' })

    expect(document.body).toHaveFocus()
  })

  it('drops a pending return when the sheet closes', () => {
    const { api, rerender } = renderHarness({ rows: [] })
    act(() => api().focusActionsButton('b'))

    rerender({ rows: [], open: false })
    rerender({ rows: ['b'], open: true })

    expect(document.body).toHaveFocus()
  })

  it('forgets a button once its row unmounts', () => {
    const { api, rerender } = renderHarness({ rows: ['a'] })
    rerender({ rows: [] })

    act(() => api().focusActionsButton('a'))
    expect(document.body).toHaveFocus()

    // It is still pending for when the row comes back.
    rerender({ rows: ['a'] })
    expect(screen.getByText('actions a')).toHaveFocus()
  })

  describe('focusSheetIfLost', () => {
    it('parks focus on the sheet content element when focus fell to <body>', () => {
      const { api } = renderHarness()
      expect(document.body).toHaveFocus()

      act(() => api().focusSheetIfLost())

      expect(screen.getByTestId('sheet')).toHaveFocus()
    })

    it('never takes focus a control already holds', () => {
      const { api } = renderHarness()
      act(() => screen.getByText('other control').focus())

      act(() => api().focusSheetIfLost())

      expect(screen.getByText('other control')).toHaveFocus()
    })
  })
})
