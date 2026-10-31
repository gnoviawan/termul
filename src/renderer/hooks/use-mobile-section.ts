import type { WorkspaceTab } from '@/stores/workspace-store'

/** The mobile drawer's sections (its nav rows: Chats, Terminals, Editors, GitHub). */
export type MobileSection = 'chats' | 'terminals' | 'editors' | 'github'

export const MOBILE_SECTIONS: readonly MobileSection[] = ['chats', 'terminals', 'editors', 'github']

/**
 * The section a tab kind belongs to. Editors holds editor files, Git Changes,
 * Diff and Browser tabs (and a stray canvas tab, for exhaustiveness: canvas has
 * no web UI of its own). A GitHub issue or PR belongs to GitHub, the list it
 * was opened from. Git History and Automations live in the drawer footer, so
 * they belong to none.
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
    case 'diff':
    case 'commit-diff':
    case 'browser':
    case 'canvas':
      return 'editors'
    case 'github-item':
      return 'github'
    case 'git-history':
    case 'automations':
      return null
    default: {
      const unhandled: never = tab
      void unhandled
      return null
    }
  }
}
