/**
 * Keyboard Shortcuts Settings Page Component
 *
 * Main settings page for managing keyboard shortcuts.
 * Lists all shortcuts with remap functionality and Vim navigation toggle.
 * Source: Story 3.3 - Task 4.1: Create KeyboardShortcutsSettings page component
 */

import { useEffect, useCallback, useState } from 'react'
import { Keyboard, RotateCcw } from 'lucide-react'
import { ShortcutList } from './ShortcutList'
import { ShortcutRemapDialog } from './ShortcutRemapDialog'
import { useShortcuts, usePlatform, useIsLoading, useShortcutsError, useVimNavigationEnabled, useShortcutActions, useRemapDialogState, useRemappingShortcut, useCapturedKeybinding, useConflictWarning } from '../keyboard-shortcuts-store'

/**
 * KeyboardShortcutsSettings - Main keyboard shortcuts settings page
 *
 * Displays list of all shortcuts grouped by category with remap functionality.
 * Shows Vim navigation toggle and reset to defaults button.
 */
export function KeyboardShortcutsSettings() {
  const shortcuts = useShortcuts()
  const platform = usePlatform()
  const isLoading = useIsLoading()
  const error = useShortcutsError()
  const vimNavigationEnabled = useVimNavigationEnabled()
  const remapDialogState = useRemapDialogState()
  const remappingShortcut = useRemappingShortcut()
  const capturedKeybinding = useCapturedKeybinding()
  const conflictWarning = useConflictWarning()

  const [searchQuery, setSearchQuery] = useState('')

  const {
    fetchShortcuts,
    resetShortcuts,
    toggleVimNavigation,
    clearError,
    closeRemapDialog,
    captureKeybinding,
    saveRemappedShortcut
  } = useShortcutActions()

  // Load shortcuts on mount
  useEffect(() => {
    fetchShortcuts()
  }, [fetchShortcuts])

  // Handle reset to defaults
  const handleResetDefaults = useCallback(async () => {
    if (window.confirm('Are you sure you want to reset all shortcuts to defaults?')) {
      await resetShortcuts()
    }
  }, [resetShortcuts])

  // Handle Vim navigation toggle
  const handleToggleVimNavigation = useCallback(() => {
    toggleVimNavigation()
  }, [toggleVimNavigation])

  // Handle key capture in remap dialog
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (remapDialogState !== 'remap') return

    event.preventDefault()
    event.stopPropagation()

    // Map modifier keys
    const modifiers: string[] = []
    if (event.metaKey) modifiers.push('cmd')
    if (event.ctrlKey) modifiers.push('ctrl')
    if (event.altKey) modifiers.push('alt')
    if (event.shiftKey) modifiers.push('shift')

    // Escape cancels
    if (event.key === 'Escape') {
      closeRemapDialog()
      return
    }

    // Only capture combinations with modifiers
    if (modifiers.length === 0) return

    const modifier = modifiers[0] as 'cmd' | 'ctrl' | 'alt' | 'shift'
    const key = event.key.toLowerCase()

    captureKeybinding({ modifier, key })
  }, [remapDialogState, captureKeybinding, closeRemapDialog])

  // Register keyboard listener for remap dialog
  useEffect(() => {
    if (remapDialogState === 'remap') {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [remapDialogState, handleKeyDown])

  // Filter shortcuts by search query
  const filteredShortcuts = shortcuts.filter(shortcut =>
    shortcut.command.toLowerCase().includes(searchQuery.toLowerCase()) ||
    shortcut.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // Get platform display name
  const platformName = platform.startsWith('darwin') ? 'macOS' :
                       platform.startsWith('win') ? 'Windows' : 'Linux'

  return (
    <main className="flex-1 flex flex-col min-w-0 h-full relative">
      {/* Header */}
      <div className="h-16 flex items-center justify-between px-8 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded text-primary">
            <Keyboard size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground leading-tight">
              Keyboard Shortcuts
            </h1>
            <p className="text-xs text-muted-foreground">
              Manage keyboard shortcuts ({platformName})
            </p>
          </div>
        </div>

        <button
          onClick={handleResetDefaults}
          className="flex items-center gap-2 px-4 py-2 border border-border hover:bg-secondary text-foreground text-sm font-medium rounded transition-all"
        >
          <RotateCcw size={16} />
          Reset to Defaults
        </button>
      </div>

      {/* Vim Navigation Toggle */}
      <div className="h-14 flex items-center justify-between px-8 border-b border-border bg-secondary/10 flex-shrink-0">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="vim-navigation"
            checked={vimNavigationEnabled}
            onChange={handleToggleVimNavigation}
            className="w-4 h-4 rounded border-border"
          />
          <label htmlFor="vim-navigation" className="text-sm text-foreground cursor-pointer">
            Enable Vim-style navigation (j, k, h, l)
          </label>
        </div>
      </div>

      {/* Search */}
      <div className="px-8 py-4 border-b border-border">
        <input
          type="text"
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-4 py-2 bg-secondary border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary text-foreground text-sm"
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        {isLoading ? (
          <div className="text-center text-muted-foreground">Loading shortcuts...</div>
        ) : error ? (
          <div className="text-center text-destructive">
            {error}
            <button
              onClick={clearError}
              className="ml-2 text-primary hover:underline"
            >
              Dismiss
            </button>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto">
            <ShortcutList
              shortcuts={filteredShortcuts}
            />
          </div>
        )}
      </div>

      {/* Remap Dialog */}
      {remapDialogState === 'remap' && remappingShortcut && (
        <ShortcutRemapDialog
          isOpen
          shortcut={remappingShortcut}
          capturedKeybinding={capturedKeybinding}
          conflictWarning={conflictWarning}
          onSave={saveRemappedShortcut}
          onCancel={closeRemapDialog}
        />
      )}
    </main>
  )
}
