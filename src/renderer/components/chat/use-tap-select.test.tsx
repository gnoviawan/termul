import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTapSelect } from './use-tap-select'

function Row({ onSelect }: { onSelect: () => void }): React.JSX.Element {
  const tapSelect = useTapSelect()
  return (
    <button type="button" {...tapSelect(onSelect)}>
      row
    </button>
  )
}

const touch = (x: number, y: number) => ({ clientX: x, clientY: y })

describe('useTapSelect', () => {
  it('selects on click without touch', () => {
    const onSelect = vi.fn()
    render(<Row onSelect={onSelect} />)
    fireEvent.click(screen.getByText('row'))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('a tap selects once and drops the synthesized click', () => {
    const onSelect = vi.fn()
    render(<Row onSelect={onSelect} />)
    const row = screen.getByText('row')
    fireEvent.touchStart(row, { touches: [touch(10, 10)] })
    fireEvent.touchEnd(row, { changedTouches: [touch(14, 13)] })
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('a drag-scroll past 10px does not select', () => {
    const onSelect = vi.fn()
    render(<Row onSelect={onSelect} />)
    const row = screen.getByText('row')
    fireEvent.touchStart(row, { touches: [touch(10, 10)] })
    fireEvent.touchEnd(row, { changedTouches: [touch(10, 40)] })
    expect(onSelect).not.toHaveBeenCalled()
  })
})
