import type { TabReorderPosition } from '@/types/workspace.types'
import type { TabBulkMenuProps } from '../tab-context-menu'

/**
 * Props every per-tab-type leaf under `tabs/` shares: WorkspaceTabBar
 * computes drag/drop state and the bulk-close menu handlers once per tab
 * and drills them down unchanged. Each leaf adds only its own `tab` (or
 * `terminal`) payload plus kind-specific callbacks (rename, copy-path,
 * closing flag).
 */
export interface TabInlineProps {
  isActive: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPosition: TabReorderPosition | null
  bulkMenu: TabBulkMenuProps
  onSelect: () => void
  onClose: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}
