/**
 * Shortcut Item Component
 *
 * Displays a single keyboard shortcut with remap button.
 * Source: Story 3.3 - Task 4.3: Create ShortcutItem component
 */

import { useMemo } from 'react'
import { Edit, RotateCcw } from 'lucide-react'
import type { KeyboardShortcut } from '@shared/types/keyboard-shortcuts.types'

interface ShortcutItemProps {
  shortcut: KeyboardShortcut
  onRemap: () => void
}

/**
 * Format keybinding for display
 */
function formatKeybindingDisplay(shortcut: KeyboardShortcut): string {
  const { modifier, key } = shortcut.currentUserKeybinding

  // On macOS, Cmd stays as Cmd; on Windows/Linux, Cmd becomes Ctrl
  let displayModifier: 'cmd' | 'ctrl' | 'alt' | 'shift' | 'meta' = modifier
  if (typeof window !== 'undefined' && window.navigator.platform) {
    const platform = window.navigator.platform
    if (modifier === 'cmd' && !platform.startsWith('darwin')) {
      displayModifier = 'ctrl'
    }
    if (modifier === 'ctrl' && platform.startsWith('darwin')) {
      displayModifier = 'cmd'
    }
  }

  // Capitalize first letter of modifier
  const formattedModifier = displayModifier.charAt(0).toUpperCase() + displayModifier.slice(1)

  // Capitalize the key
  const formattedKey = key.charAt(0).toUpperCase() + key.slice(1)

  return `${formattedModifier}+${formattedKey}`
}

/**
 * ShortcutItem - Single shortcut row with remap button
 *
 * Shows shortcut command, description, and current keybinding.
 * Includes remap button for editable shortcuts.
 */
export function ShortcutItem({ shortcut, onRemap }: ShortcutItemProps) {
  const keybindingDisplay = useMemo(() => formatKeybindingDisplay(shortcut), [shortcut])

  const isCustomized = shortcut.defaultKeybinding.modifier !== shortcut.currentUserKeybinding.modifier ||
                       shortcut.defaultKeybinding.key !== shortcut.currentUserKeybinding.key

  return (
    <div className="flex items-center justify-between p-4 bg-card border border-border rounded hover:border-primary/50 transition-colors">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">
            {shortcut.description}
          </h3>
          {isCustomized && (
            <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded">
              Customized
            </span>
          )}
          {!shortcut.isEditable && (
            <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
              Default
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Command: <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">{shortcut.command}</code>
        </p>
      </div>

      <div className="flex items-center gap-3">
        {/* Current keybinding */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary border border-border rounded">
          <kbd className="text-sm font-mono text-foreground">
            {keybindingDisplay}
          </kbd>
        </div>

        {/* Actions */}
        {shortcut.isEditable && (
          <div className="flex items-center gap-1">
            <button
              onClick={onRemap}
              className="p-1.5 hover:bg-secondary rounded transition-colors"
              title="Remap shortcut"
            >
              <Edit size={14} className="text-muted-foreground hover:text-foreground" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
