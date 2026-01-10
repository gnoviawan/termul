import { useEffect, useRef, useCallback } from 'react'

export interface UseTerminalResizeOptions {
  onResize: (cols: number, rows: number) => void
  debounceMs?: number
}

export interface UseTerminalResizeReturn {
  containerRef: React.RefObject<HTMLDivElement | null>
  triggerResize: () => void
}

export function useTerminalResize(options: UseTerminalResizeOptions): UseTerminalResizeReturn {
  const { onResize, debounceMs = 100 } = options
  const containerRef = useRef<HTMLDivElement | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastDimensionsRef = useRef<{ width: number; height: number } | null>(null)

  const calculateDimensions = useCallback((): { cols: number; rows: number } | null => {
    if (!containerRef.current) return null

    const rect = containerRef.current.getBoundingClientRect()
    const charWidth = 9
    const charHeight = 17
    const padding = 16

    const cols = Math.floor((rect.width - padding) / charWidth)
    const rows = Math.floor((rect.height - padding) / charHeight)

    if (cols > 0 && rows > 0) {
      return { cols, rows }
    }
    return null
  }, [])

  const triggerResize = useCallback((): void => {
    const dimensions = calculateDimensions()
    if (dimensions) {
      onResize(dimensions.cols, dimensions.rows)
    }
  }, [calculateDimensions, onResize])

  useEffect(() => {
    if (!containerRef.current) return

    const handleResize = (entries: ResizeObserverEntry[]): void => {
      const entry = entries[0]
      if (!entry) return

      const { width, height } = entry.contentRect
      const last = lastDimensionsRef.current

      if (last && last.width === width && last.height === height) {
        return
      }

      lastDimensionsRef.current = { width, height }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      debounceTimerRef.current = setTimeout(() => {
        triggerResize()
      }, debounceMs)
    }

    const observer = new ResizeObserver(handleResize)
    observer.observe(containerRef.current)
    resizeObserverRef.current = observer

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      observer.disconnect()
      resizeObserverRef.current = null
    }
  }, [debounceMs, triggerResize])

  return {
    containerRef,
    triggerResize
  }
}
