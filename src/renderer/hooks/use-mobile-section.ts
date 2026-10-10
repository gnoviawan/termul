import type { WorkspaceTab } from '@/stores/workspace-store'

/** The mobile drawer's sections (its nav rows: Chats, Terminals, Editors). */
export type MobileSection = 'chats' | 'terminals' | 'editors'

export const MOBILE_SECTIONS: readonly MobileSection[] = ['chats', 'terminals', 'editors']

/**
 * The section a tab kind belongs to. Editors holds editor files, Git Changes
 * and Browser tabs (and a stray canvas tab, for exhaustiveness: canvas has no
 * web UI of its own). Git History lives in the menu, so it belongs to none.
 */
export function sectionForTab(tab: WorkspaceTab | null | undefined): MobileSection | null {
  if (!tab) return null
  switch (tab.type) {
    case 'agent-chat':
      return 'chats'
    case 'terminal':
      return 'terminals'
    case 'editor':
    case 'git':
    case 'browser':
    case 'canvas':
      return 'editors'
    case 'git-history':
      return null
    default: {
      const unhandled: never = tab
      void unhandled
      return null
    }
  }
}
