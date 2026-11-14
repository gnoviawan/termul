import type { ShellLastColumnTab } from '@/stores/shell-layout-store'

/** A Side panel tab that has a button. Chats moved to the Rail (Sidebar V2 P1). */
export type VisibleColumnTab = Exclude<ShellLastColumnTab, 'chats'>

/**
 * The tab the Side panel shows for a stored last tab. `chats` is still a valid
 * persisted value (no record version bump in P1) but has no tab, so it and
 * no value at all read as Explorer.
 */
export function visibleColumnTab(tab: ShellLastColumnTab | undefined): VisibleColumnTab {
  return tab === undefined || tab === 'chats' ? 'explorer' : tab
}
