import { useResizeHandle } from '@/hooks/use-resize-handle'
import { SHELL_LAYOUT_BOUNDS, useRailWidth, useShellLayoutStore } from '@/stores/shell-layout-store'

interface RailResize {
  width: number
  onResizeMouseDown: (event: React.MouseEvent<HTMLElement>) => void
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

/**
 * Pointer drag and keyboard resize of the expanded Rail. The width lives in
 * the shell-layout store, which clamps it to 180-360 and persists it.
 */
export function useRailResize(): RailResize {
  const width = useRailWidth()
  const { onDragStart, onKeyDown } = useResizeHandle({
    axis: 'x',
    direction: 1,
    min: SHELL_LAYOUT_BOUNDS.railWidth.min,
    max: SHELL_LAYOUT_BOUNDS.railWidth.max,
    read: () => useShellLayoutStore.getState().railWidth,
    write: (next) => useShellLayoutStore.getState().setRailWidth(next),
    cursor: 'col-resize'
  })
  return { width, onResizeMouseDown: onDragStart, onResizeKeyDown: onKeyDown }
}
