import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePreventFileDropNavigation } from './use-prevent-file-drop-navigation'

interface DragEventInit {
  types?: string[]
  /** Simulate a feature drop zone that already called `preventDefault()`. */
  zonePrevented?: boolean
  /** Simulate a feature drop zone that set its own `dropEffect`. */
  zoneDropEffect?: DataTransfer['dropEffect']
}

function makeDragEvent(type: 'dragover' | 'drop', init: DragEventInit = {}): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  // A zone handler at the target runs before window bubble; a pre-empted
  // default and pre-set dropEffect stand in for its work during dispatch.
  if (init.zonePrevented) event.preventDefault()
  const dropEffectHolder = { value: 'uninitialized' as DataTransfer['dropEffect'] }
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: init.types ?? [],
      get dropEffect() {
        return dropEffectHolder.value
      },
      set dropEffect(next: DataTransfer['dropEffect']) {
        dropEffectHolder.value = next
      }
    },
    configurable: true
  })
  if (init.zoneDropEffect) dropEffectHolder.value = init.zoneDropEffect
  return event
}

function dispatchDragEvent(type: 'dragover' | 'drop', init: DragEventInit = {}): DragEvent {
  const event = makeDragEvent(type, init)
  window.dispatchEvent(event)
  return event
}

/** Dispatch from a body child so the event must propagate to reach window. */
function dispatchDragEventFromElement(
  type: 'dragover' | 'drop',
  init: DragEventInit = {}
): DragEvent {
  const event = makeDragEvent(type, init)
  const target = document.createElement('div')
  document.body.appendChild(target)
  target.dispatchEvent(event)
  target.remove()
  return event
}

describe('usePreventFileDropNavigation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prevents default navigation when an external file is dropped', () => {
    renderHook(() => usePreventFileDropNavigation())

    const event = dispatchDragEvent('drop', { types: ['Files'] })

    expect(event.defaultPrevented).toBe(true)
  })

  it('prevents default and sets dropEffect none on dragover with files', () => {
    renderHook(() => usePreventFileDropNavigation())

    const event = dispatchDragEvent('dragover', { types: ['Files'] })

    expect(event.defaultPrevented).toBe(true)
    expect(event.dataTransfer?.dropEffect).toBe('none')
  })

  it('ignores internal drags that do not carry OS files', () => {
    renderHook(() => usePreventFileDropNavigation())

    const dragOver = dispatchDragEvent('dragover', { types: ['text/plain'] })
    const drop = dispatchDragEvent('drop', { types: ['text/plain'] })

    expect(dragOver.defaultPrevented).toBe(false)
    expect(drop.defaultPrevented).toBe(false)
  })

  it('does not stop propagation: feature drop zones still receive the drop', () => {
    renderHook(() => usePreventFileDropNavigation())

    const seen: DragEvent[] = []
    const zoneListener = (e: Event): void => {
      seen.push(e as DragEvent)
    }
    document.addEventListener('drop', zoneListener)
    try {
      const event = dispatchDragEventFromElement('drop', { types: ['Files'] })

      // The guard still prevents navigation…
      expect(event.defaultPrevented).toBe(true)
      // …but the composer/zone listener below window also fired.
      expect(seen).toHaveLength(1)
    } finally {
      document.removeEventListener('drop', zoneListener)
    }
  })

  it('leaves zone-handled drops alone (defaultPrevented honored)', () => {
    renderHook(() => usePreventFileDropNavigation())

    const seen: DragEvent[] = []
    const listener = (e: Event): void => {
      seen.push(e as DragEvent)
    }
    window.addEventListener('drop', listener)
    try {
      dispatchDragEventFromElement('drop', { types: ['Files'], zonePrevented: true })

      expect(seen).toHaveLength(1)
    } finally {
      window.removeEventListener('drop', listener)
    }
  })

  it('does not force the no-drop cursor over a zone-handled dragover', () => {
    renderHook(() => usePreventFileDropNavigation())

    const event = dispatchDragEventFromElement('dragover', {
      types: ['Files'],
      zonePrevented: true,
      zoneDropEffect: 'copy'
    })

    expect(event.dataTransfer?.dropEffect).toBe('copy')
  })

  it('removes its listeners on unmount', () => {
    const { unmount } = renderHook(() => usePreventFileDropNavigation())
    unmount()

    const event = dispatchDragEvent('drop', { types: ['Files'] })

    expect(event.defaultPrevented).toBe(false)
  })
})
