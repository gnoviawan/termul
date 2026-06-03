/**
 * Worktree keyboard shortcut definitions and Command Palette integration.
 *
 * Defines shortcuts for all primary worktree operations and
 * registers them as Command Palette actions.
 */

export interface WorktreeShortcut {
  id: string
  label: string
  description: string
  /** Default key binding (platform-appropriate) */
  defaultBinding: string
  /** Platform-specific overrides */
  macBinding?: string
  /** Category for Command Palette grouping */
  category: 'create' | 'navigate' | 'modify' | 'merge'
}

/** All worktree keyboard shortcuts */
export const WORKTREE_SHORTCUTS: WorktreeShortcut[] = [
  {
    id: 'worktree.create',
    label: 'Create Worktree',
    description: 'Open the new worktree creation modal',
    defaultBinding: 'Ctrl+Shift+N',
    macBinding: 'Cmd+Shift+N',
    category: 'create'
  },
  {
    id: 'worktree.switch-next',
    label: 'Switch to Next Worktree',
    description: 'Cycle to the next worktree in the sidebar',
    defaultBinding: 'Ctrl+Shift+ArrowDown',
    macBinding: 'Cmd+Shift+ArrowDown',
    category: 'navigate'
  },
  {
    id: 'worktree.switch-prev',
    label: 'Switch to Previous Worktree',
    description: 'Cycle to the previous worktree in the sidebar',
    defaultBinding: 'Ctrl+Shift+ArrowUp',
    macBinding: 'Cmd+Shift+ArrowUp',
    category: 'navigate'
  },
  {
    id: 'worktree.switch-root',
    label: 'Switch to Project Root',
    description: 'Switch active context to the project root directory',
    defaultBinding: 'Ctrl+Shift+Home',
    macBinding: 'Cmd+Shift+Home',
    category: 'navigate'
  },
  {
    id: 'worktree.open-terminal',
    label: 'Open Terminal in Worktree',
    description: 'Spawn a new terminal in the active worktree',
    defaultBinding: 'Ctrl+Shift+T',
    macBinding: 'Cmd+Shift+T',
    category: 'navigate'
  },
  {
    id: 'worktree.archive',
    label: 'Archive Active Worktree',
    description: 'Archive the current active worktree',
    defaultBinding: 'Ctrl+Shift+A',
    macBinding: 'Cmd+Shift+A',
    category: 'modify'
  },
  {
    id: 'worktree.merge-to-main',
    label: 'Merge Worktree to Main',
    description: 'Start merge workflow: worktree branch → main',
    defaultBinding: 'Ctrl+Shift+M',
    macBinding: 'Cmd+Shift+M',
    category: 'merge'
  },
  {
    id: 'worktree.sync-from-main',
    label: 'Sync Main into Worktree',
    description: 'Start merge workflow: main → worktree branch',
    defaultBinding: 'Ctrl+Shift+S',
    macBinding: 'Cmd+Shift+S',
    category: 'merge'
  }
]

/**
 * Command Palette action items for worktree operations.
 */
export interface CommandPaletteAction {
  id: string
  label: string
  description: string
  category: string
  /** Keyboard shortcut to display */
  shortcut?: string
  /** Action handler reference */
  action: () => void
}

/**
 * Get the platform-appropriate key binding for a shortcut.
 */
export function getPlatformBinding(shortcut: WorktreeShortcut): string {
  if (navigator.platform.startsWith('Mac') && shortcut.macBinding) {
    return shortcut.macBinding
  }
  return shortcut.defaultBinding
}

/**
 * Format a key binding for display.
 * Converts Ctrl to ⌘ on Mac, ArrowUp to ↑, etc.
 */
export function formatBindingForDisplay(binding: string): string {
  const isMac = navigator.platform.startsWith('Mac')
  return binding
    .replace('Ctrl', isMac ? '⌘' : 'Ctrl')
    .replace('Cmd', '⌘')
    .replace('Shift', '⇧')
    .replace('ArrowUp', '↑')
    .replace('ArrowDown', '↓')
    .replace('ArrowLeft', '←')
    .replace('ArrowRight', '→')
    .replace('Home', '↖')
    .replace('End', '↘')
}
