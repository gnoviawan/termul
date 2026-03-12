import type { WorkspaceTab } from '@/stores/workspace-store'

export type PaneDirection = 'horizontal' | 'vertical'

export interface SplitNode {
  type: 'split'
  id: string
  direction: PaneDirection
  children: PaneNode[]
  sizes: number[]
}

export interface LeafNode {
  type: 'leaf'
  id: string
  tabs: WorkspaceTab[]
  activeTabId: string | null
}

export type PaneNode = SplitNode | LeafNode

// Pane-relative drop positions for creating splits
export type DropPosition = 'left' | 'right' | 'top' | 'bottom' | 'center'

// Tab-relative positions for intra-pane reordering
export type TabReorderPosition = 'before' | 'after'

export interface DragPayload {
  type: 'tab' | 'file'
  tabId?: string
  filePath?: string
  sourcePaneId?: string
}
