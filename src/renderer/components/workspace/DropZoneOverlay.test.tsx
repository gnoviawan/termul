import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { framerMotionTestState, resetFramerMotionTestState } from '@/test-utils/mock-framer-motion'
import { DropZoneOverlay } from './DropZoneOverlay'

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: vi.fn()
}))

// Spec I/O matrix — "Edge drop / aborted" row: the shared framer-motion mock
// records motion.div props so the root's enter/exit fade (and reduced-motion
// instant variant) is assertable without timing.
vi.mock('framer-motion', async (importOriginal) => {
  const { installFramerMotionMock } = await import('@/test-utils/mock-framer-motion')
  return installFramerMotionMock(importOriginal)
})

describe('DropZoneOverlay', () => {
  const handleDrop = vi.fn()
  const setPreviewTarget = vi.fn()
  const clearPreviewTarget = vi.fn()

  beforeEach(() => {
    handleDrop.mockReset()
    setPreviewTarget.mockReset()
    clearPreviewTarget.mockReset()
    resetFramerMotionTestState()

    ;(usePaneDnd as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      handleDrop,
      isDragging: true,
      previewTarget: null,
      setPreviewTarget,
      clearPreviewTarget
    })
  })

  // DOM order: [0] overlay root, [1] morphing highlight rect, [2..6] the five
  // invisible zone hit targets (left, right, top, bottom, center).
  it('updates shared preview target on zone drag enter', () => {
    const { container } = render(<DropZoneOverlay paneId="pane-a" />)

    const zones = container.querySelectorAll('.absolute')
    const leftZone = zones[2] as HTMLElement

    fireEvent.dragEnter(leftZone)

    expect(setPreviewTarget).toHaveBeenCalledWith('pane-a', 'left')
  })

  it('dispatches drop through context and clears preview for the dropped zone', () => {
    const { container } = render(<DropZoneOverlay paneId="pane-a" />)

    const zones = container.querySelectorAll('.absolute')
    const centerZone = zones[6] as HTMLElement

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
      isDragging: true,
      previewTarget: { paneId: 'pane-a', position: 'top' },
      setPreviewTarget,
      clearPreviewTarget
    })

    const { container } = render(<DropZoneOverlay paneId="pane-a" />)
    const zones = container.querySelectorAll('.absolute')
    const highlight = zones[1] as HTMLElement

    // Single morphing highlight adopts the hovered zone's geometry.
    expect(highlight.className).toContain('bg-primary/10')
    expect(highlight.style.opacity).toBe('1')
    expect(highlight.style.top).toBe('0%')
    expect(highlight.style.bottom).toBe('75%')
    expect(highlight.style.left).toBe('25%')
    expect(highlight.style.right).toBe('25%')
  })

  it('roots the overlay in a motion.div wired for enter/exit opacity fades', () => {
    render(<DropZoneOverlay paneId="pane-a" />)

    // The only motion.div rendered by this component is the overlay root —
    // its exit opacity is what plays when a drag aborts off-target (the
    // AnimatePresence gate lives in PaneContent).
    const root = framerMotionTestState.motionDivPropsLog.at(-1)
    expect(root).toBeTruthy()
    expect(root?.initial).toEqual({ opacity: 0 })
    expect(root?.animate).toEqual({ opacity: 1 })
    expect(root?.exit).toEqual({ opacity: 0 })
    expect((root?.transition as { duration: number }).duration).toBeLessThanOrEqual(0.15)
  })

  it('applies instantly under prefers-reduced-motion (initial=false, zero duration)', () => {
    framerMotionTestState.reducedMotion.current = true

    render(<DropZoneOverlay paneId="pane-a" />)

    const root = framerMotionTestState.motionDivPropsLog.at(-1)
    expect(root?.initial).toBe(false)
    expect((root?.transition as { duration: number }).duration).toBe(0)
    // Exit still exists so the overlay can leave — instantly, not skipped.
    expect(root?.exit).toEqual({ opacity: 0 })
  })

  it('is click-through when the drag is over (exit fade must not swallow pane clicks)', () => {
    ;(usePaneDnd as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      handleDrop,
      isDragging: false,
      previewTarget: null,
      setPreviewTarget,
      clearPreviewTarget
    })

    const { container } = render(<DropZoneOverlay paneId="pane-a" />)

    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('pointer-events-none')
    expect(root.className).not.toContain('pointer-events-auto')
  })
})
