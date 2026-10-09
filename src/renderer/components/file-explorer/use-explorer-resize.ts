import { useCallback, useEffect, useRef, useState } from 'react'

const WIDTH_STORAGE_KEY = 'termul:file-explorer-width'
export const EXPLORER_MIN_WIDTH = 220
export const EXPLORER_MAX_WIDTH = 560
const DEFAULT_WIDTH = 256

function readSavedWidth(): number {
  try {
    const savedWidth = window.localStorage?.getItem(WIDTH_STORAGE_KEY)
    if (!savedWidth) return DEFAULT_WIDTH
    const parsed = Number.parseInt(savedWidth, 10)
    if (Number.isNaN(parsed)) return DEFAULT_WIDTH
    return Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, parsed))
  } catch {
    return DEFAULT_WIDTH
  }
}

interface ExplorerResize {
  width: number
  onResizeMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => void
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}

/**
 * Persisted explorer width with pointer drag and keyboard resize. `side` is
 * the panel side: on the right, dragging left makes the panel wider.
 */
export function useExplorerResize(side: 'left' | 'right'): ExplorerResize {
  const [width, setWidth] = useState(readSavedWidth)
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    try {
      window.localStorage?.setItem(WIDTH_STORAGE_KEY, String(width))
    } catch {
      // Ignore localStorage access failures in restricted environments.
    }
  }, [width])

  const finalizeResizeDrag = useCallback(() => {
    resizeStateRef.current = null
    document.body.style.userSelect = ''
    if (resizeCleanupRef.current) {
      resizeCleanupRef.current()
      resizeCleanupRef.current = null
    }
  }, [])

  const applyResizedWidth = useCallback((rawWidth: number) => {
    setWidth(Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, rawWidth)))
  }, [])

  const onResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      document.body.style.userSelect = 'none'
      resizeStateRef.current = { startX: event.clientX, startWidth: width }

      const onMouseMove = (moveEvent: MouseEvent) => {
        const state = resizeStateRef.current
        if (!state) return
        const delta = moveEvent.clientX - state.startX
        const rawWidth = side === 'right' ? state.startWidth - delta : state.startWidth + delta
        applyResizedWidth(rawWidth)
      }

      const onMouseUp = () => {
        finalizeResizeDrag()
      }

      const onWindowBlur = () => {
        finalizeResizeDrag()
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      window.addEventListener('blur', onWindowBlur)
      resizeCleanupRef.current = () => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        window.removeEventListener('blur', onWindowBlur)
      }
    },
    [applyResizedWidth, width, finalizeResizeDrag, side]
  )

  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (
        event.key !== 'ArrowLeft' &&
        event.key !== 'ArrowRight' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      ) {
        return
      }
      event.preventDefault()
      const step = 16
      if (event.key === 'Home') {
        applyResizedWidth(EXPLORER_MIN_WIDTH)
        return
      }
      if (event.key === 'End') {
        applyResizedWidth(EXPLORER_MAX_WIDTH)
        return
      }
      const directionalDelta = event.key === 'ArrowLeft' ? -step : step
      const signedDelta = side === 'right' ? -directionalDelta : directionalDelta
      applyResizedWidth(width + signedDelta)
    },
    [applyResizedWidth, width, side]
  )

  useEffect(() => {
    return () => {
      finalizeResizeDrag()
    }
  }, [finalizeResizeDrag])

  return { width, onResizeMouseDown, onResizeKeyDown }
}
