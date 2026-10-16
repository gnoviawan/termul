import { useCallback, useEffect, useRef } from 'react'

/** Keyboard resize step (px). */
const RESIZE_KEY_STEP = 16

export interface ResizeHandleOptions {
  /** Axis the pointer moves along: `x` for a width, `y` for a height. */
  axis: 'x' | 'y'
  /** `1`: moving toward +axis (right or down) grows the value; `-1`: it shrinks it. */
  direction: 1 | -1
  min: number
  max: number
  /** Latest value; read when a drag starts and on each key press. */
  read: () => number
  /** Receives every new value. The owner clamps it and persists it. */
  write: (value: number) => void
  /** Use pointer events (main button only) instead of mouse events. */
  pointer?: boolean
  /** Body cursor while dragging. */
  cursor?: string
}

interface ResizeHandle {
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

/**
 * Drag and keyboard resize for one separator, for any axis and growth
 * direction. Arrow keys along the axis step by {@link RESIZE_KEY_STEP}; Home
 * and End jump to the bounds. Document listeners are removed on release, on
 * window blur and on unmount.
 */
export function useResizeHandle(options: ResizeHandleOptions): ResizeHandle {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const cleanupRef = useRef<(() => void) | null>(null)

  const endDrag = useCallback(() => {
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    cleanupRef.current?.()
    cleanupRef.current = null
  }, [])

  const onDragStart = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const { axis, direction, read, write, pointer, cursor } = optionsRef.current
      if (pointer && event.button !== 0) return
      event.preventDefault()
      endDrag()
      document.body.style.userSelect = 'none'
      if (cursor) document.body.style.cursor = cursor
      const start = axis === 'x' ? event.clientX : event.clientY
      const startValue = read()
      const [moveType, upType] = pointer ? ['pointermove', 'pointerup'] : ['mousemove', 'mouseup']

      const onMove = (move: Event): void => {
        const point = move as MouseEvent
        write(startValue + direction * ((axis === 'x' ? point.clientX : point.clientY) - start))
      }
      document.addEventListener(moveType, onMove)
      document.addEventListener(upType, endDrag)
      if (pointer) document.addEventListener('pointercancel', endDrag)
      window.addEventListener('blur', endDrag)
      cleanupRef.current = () => {
        document.removeEventListener(moveType, onMove)
        document.removeEventListener(upType, endDrag)
        document.removeEventListener('pointercancel', endDrag)
        window.removeEventListener('blur', endDrag)
      }
    },
    [endDrag]
  )

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const { axis, direction, min, max, read, write } = optionsRef.current
    const [shrinkKey, growKey] =
      axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    let next: number
    if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else if (event.key === growKey) next = read() + direction * RESIZE_KEY_STEP
    else if (event.key === shrinkKey) next = read() - direction * RESIZE_KEY_STEP
    else return
    event.preventDefault()
    write(next)
  }, [])

  // A drag in flight when the owner unmounts must not leak its listeners.
  useEffect(() => endDrag, [endDrag])

  return { onDragStart, onKeyDown }
}
