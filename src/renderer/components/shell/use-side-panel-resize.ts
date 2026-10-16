import { useResizeHandle } from '@/hooks/use-resize-handle'
import {
  SHELL_LAYOUT_BOUNDS,
  useShellLayoutStore,
  useSidePanelWidth
} from '@/stores/shell-layout-store'

const { min: MIN_WIDTH, max: MAX_WIDTH } = SHELL_LAYOUT_BOUNDS.sidePanelWidth

interface SidePanelResize {
  width: number
  min: number
  max: number
  onResizeMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => void
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}

/**
 * Side panel width with pointer drag and keyboard resize for a panel against
 * the left edge (dragging right widens it). The width lives in the shell-layout
 * store, which clamps to its bounds and ignores writes until hydrated.
 */
export function useSidePanelResize(): SidePanelResize {
  const width = useSidePanelWidth()
  const { onDragStart, onKeyDown } = useResizeHandle({
    axis: 'x',
    direction: 1,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    read: () => useShellLayoutStore.getState().sidePanelWidth,
    write: (next) => useShellLayoutStore.getState().setSidePanelWidth(next)
  })
  return {
    width,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    onResizeMouseDown: onDragStart,
    onResizeKeyDown: onKeyDown
  }
}
