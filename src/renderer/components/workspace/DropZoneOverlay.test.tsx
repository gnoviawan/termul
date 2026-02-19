import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { DropZoneOverlay } from './DropZoneOverlay'
import { usePaneDnd } from '@/hooks/use-pane-dnd'

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: vi.fn()
}))

describe('DropZoneOverlay', () => {
  const handleDrop = vi.fn()
  const setPreviewTarget = vi.fn()
  const clearPreviewTarget = vi.fn()

  beforeEach(() => {
    handleDrop.mockReset()
    setPreviewTarget.mockReset()
    clearPreviewTarget.mockReset()

    ;(usePaneDnd as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      handleDrop,
      previewTarget: null,
      setPreviewTarget,
      clearPreviewTarget
    })
  })

  it('updates shared preview target on zone drag enter', () => {
    const { container } = render(<DropZoneOverlay paneId="pane-a" />)

    const zones = container.querySelectorAll('.absolute')
    const leftZone = zones[1] as HTMLElement

    fireEvent.dragEnter(leftZone)

    expect(setPreviewTarget).toHaveBeenCalledWith('pane-a', 'left')
  })

  it('dispatches drop through context and clears preview for the dropped zone', () => {
    const { container } = render(<DropZoneOverlay paneId="pane-a" />)

    const zones = container.querySelectorAll('.absolute')
    const centerZone = zones[5] as HTMLElement

    const dropDataTransfer = {
      getData: vi.fn().mockReturnValue(''),
      setData: vi.fn()
    } as unknown as DataTransfer

    fireEvent.drop(centerZone, { dataTransfer: dropDataTransfer })

    expect(clearPreviewTarget).toHaveBeenCalledWith('pane-a', 'center')
    expect(handleDrop).toHaveBeenCalled()
    expect(handleDrop.mock.calls[0][0]).toBe('pane-a')
    expect(handleDrop.mock.calls[0][1]).toBe('center')
  })

  it('clears preview when leaving overlay container', () => {
    const { container } = render(<DropZoneOverlay paneId="pane-a" />)

    const overlay = container.firstChild as HTMLElement
    fireEvent.dragLeave(overlay)

    expect(clearPreviewTarget).toHaveBeenCalledWith('pane-a')
  })

  it('renders hovered zone style from shared preview target', () => {
    ;(usePaneDnd as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      handleDrop,
      previewTarget: { paneId: 'pane-a', position: 'top' },
      setPreviewTarget,
      clearPreviewTarget
    })

    const { container } = render(<DropZoneOverlay paneId="pane-a" />)
    const zones = container.querySelectorAll('.absolute')
    const topZone = zones[3] as HTMLElement

    expect(topZone.className).toContain('bg-primary/10')
  })
})
