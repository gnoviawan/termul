import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePreventFileDropNavigation } from './use-prevent-file-drop-navigation'

interface DragEventInit {
  types?: string[]
}

function dispatchDragEvent(type: 'dragover' | 'drop', init: DragEventInit = {}): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
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
  window.dispatchEvent(event)
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

  it('removes its listeners on unmount', () => {
    const { unmount } = renderHook(() => usePreventFileDropNavigation())
    unmount()

    const event = dispatchDragEvent('drop', { types: ['Files'] })

    expect(event.defaultPrevented).toBe(false)
  })
})
