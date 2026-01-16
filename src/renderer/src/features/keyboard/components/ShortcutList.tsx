/**
 * Shortcut List Component
 *
 * Displays keyboard shortcuts grouped by category.
 * Source: Story 3.3 - Task 4.2: Create ShortcutList component
 */

import { useMemo } from 'react'
import { useShortcutActions } from '../keyboard-shortcuts-store'
import type { KeyboardShortcut, ShortcutCategory } from '@shared/types/keyboard-shortcuts.types'
import { ShortcutItem } from './ShortcutItem'

interface ShortcutListProps {
  shortcuts: KeyboardShortcut[]
}

/**
 * Category labels for display
 */
const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  'worktree-operations': 'Worktree Operations',
  'navigation': 'Navigation',
  'dialogs': 'Dialogs',
  'global': 'Global'
}

/**
 * Order of categories for display
 */
const CATEGORY_ORDER: ShortcutCategory[] = [
  'worktree-operations',
  'navigation',
  'dialogs',
  'global'
]

/**
 * ShortcutList - Groups and displays shortcuts by category
 *
 * Shows shortcuts in organized sections with category headers.
 */
export function ShortcutList({ shortcuts }: ShortcutListProps) {
  const { openRemapDialog } = useShortcutActions()

  // Group shortcuts by category
  const groupedShortcuts = useMemo(() => {
    const groups: Record<ShortcutCategory, KeyboardShortcut[]> = {
      'worktree-operations': [],
      'navigation': [],
      'dialogs': [],
      'global': []
    }

    shortcuts.forEach(shortcut => {
      groups[shortcut.category].push(shortcut)
    })

    return groups
  }, [shortcuts])

  const handleRemapShortcut = (shortcut: KeyboardShortcut) => {
    openRemapDialog(shortcut)
  }

  return (
    <div className="space-y-8">
      {CATEGORY_ORDER.map(category => {
        const categoryShortcuts = groupedShortcuts[category]

        if (categoryShortcuts.length === 0) return null

        return (
          <div key={category}>
            <h2 className="text-lg font-semibold text-foreground mb-4">
              {CATEGORY_LABELS[category]}
            </h2>
            <div className="space-y-2">
              {categoryShortcuts.map(shortcut => (
                <ShortcutItem
                  key={shortcut.id}
                  shortcut={shortcut}
                  onRemap={() => handleRemapShortcut(shortcut)}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
