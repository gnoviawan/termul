import { useResizeHandle } from '@/hooks/use-resize-handle'
import {
  SHELL_LAYOUT_BOUNDS,
  useGitHistoryDetailWidth,
  useShellLayoutStore
} from '@/stores/shell-layout-store'

export const DETAIL_PANE_MIN_WIDTH = SHELL_LAYOUT_BOUNDS.gitHistoryDetailWidth.min
export const DETAIL_PANE_MAX_WIDTH = SHELL_LAYOUT_BOUNDS.gitHistoryDetailWidth.max

interface DetailPaneResize {
  width: number
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

/**
 * Width of the Git History detail pane (320-560) and its resize handle. The
 * width lives in the shell-layout store, which clamps and persists it. The
 * handle sits on the pane's left edge: dragging left makes the pane wider.
 */
export function useDetailPaneResize(): DetailPaneResize {
  const width = useGitHistoryDetailWidth()
  const { onDragStart, onKeyDown } = useResizeHandle({
    axis: 'x',
    direction: -1,
    min: DETAIL_PANE_MIN_WIDTH,
    max: DETAIL_PANE_MAX_WIDTH,
    read: () => useShellLayoutStore.getState().gitHistoryDetailWidth,
    write: (next) => useShellLayoutStore.getState().setGitHistoryDetailWidth(next),
    pointer: true
  })
  return { width, onPointerDown: onDragStart, onKeyDown }
}
