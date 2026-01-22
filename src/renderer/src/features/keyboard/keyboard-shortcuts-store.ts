/**
 * Keyboard Shortcuts Store
 *
 * State management for keyboard shortcuts including listing, updating,
 * resetting, and Vim navigation preferences.
 * Source: Story 3.3 - Task 3: Create Keyboard Shortcuts Store
 */

import { create } from 'zustand'
import type {
  KeyboardShortcut,
  ShortcutCategory,
  UpdateShortcutDto,
  Keybinding
} from '@shared/types/keyboard-shortcuts.types'

/**
 * Remap dialog state
 */
export type RemapDialogState = 'closed' | 'remap'

/**
 * Keyboard Shortcuts store state and actions
 */
interface KeyboardShortcutsStore {
  // State
  shortcuts: KeyboardShortcut[]
  platform: string
  isLoading: boolean
  error: string | null
  vimNavigationEnabled: boolean

  // Dialog states
  remapDialogState: RemapDialogState
  remappingShortcut: KeyboardShortcut | null
  capturedKeybinding: Keybinding | null
  conflictWarning: string | null

  // Actions
  fetchShortcuts: () => Promise<void>
  updateShortcut: (shortcutId: string, keybinding: Keybinding) => Promise<void>
  resetShortcuts: () => Promise<void>
  getShortcutForCommand: (command: string) => KeyboardShortcut | undefined
  formatKeybinding: (keybinding: Keybinding) => Promise<string>
  toggleVimNavigation: () => void
  clearError: () => void

  // Remap dialog actions
  openRemapDialog: (shortcut: KeyboardShortcut) => void
  closeRemapDialog: () => void
  captureKeybinding: (keybinding: Keybinding) => void
  saveRemappedShortcut: () => Promise<void>

  // Category selectors
  getWorktreeShortcuts: () => KeyboardShortcut[]
  getNavigationShortcuts: () => KeyboardShortcut[]
  getGlobalShortcuts: () => KeyboardShortcut[]
  getShortcutsByCategory: (category: ShortcutCategory) => KeyboardShortcut[]
}

/**
 * Keyboard Shortcuts store using Zustand
 * Manages shortcut list, remapping, and Vim navigation preference
 */
export const useKeyboardShortcutsStore = create<KeyboardShortcutsStore>((set, get) => ({
  // Initial state
  shortcuts: [],
  platform: window.navigator.platform,
  isLoading: false,
  error: null,
  vimNavigationEnabled: false,
  remapDialogState: 'closed',
  remappingShortcut: null,
  capturedKeybinding: null,
  conflictWarning: null,

  // Fetch all shortcuts from IPC
  fetchShortcuts: async () => {
    set({ isLoading: true, error: null })

    try {
      const result = await window.api.keyboardShortcuts.listShortcuts()

      if (result.success) {
        set({ shortcuts: result.data || [], isLoading: false })
      } else {
        set({ error: result.error || 'Failed to load shortcuts', isLoading: false })
      }
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  // Update a keyboard shortcut via IPC
  updateShortcut: async (shortcutId: string, keybinding: Keybinding) => {
    set({ isLoading: true, error: null })

    try {
      const result = await window.api.keyboardShortcuts.updateShortcut({
        shortcutId,
        keybinding
      })

      if (result.success) {
        // Refresh shortcuts after update
        await get().fetchShortcuts()
        set({ isLoading: false })
      } else {
        // Handle conflict error
        if (result.error?.includes('Conflict')) {
          set({ conflictWarning: result.error, isLoading: false })
        } else {
          set({ error: result.error || 'Failed to update shortcut', isLoading: false })
        }
      }
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  // Reset all shortcuts to defaults via IPC
  resetShortcuts: async () => {
    set({ isLoading: true, error: null })

    try {
      const result = await window.api.keyboardShortcuts.resetShortcuts()

      if (result.success) {
        set({ shortcuts: result.data || [], isLoading: false })
      } else {
        set({ error: result.error || 'Failed to reset shortcuts', isLoading: false })
      }
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  // Get shortcut for a specific command
  getShortcutForCommand: (command: string) => {
    return get().shortcuts.find(s => s.command === command)
  },

  // Format a keybinding for display (platform-specific)
  formatKeybinding: async (keybinding: Keybinding) => {
    try {
      const result = await window.api.keyboardShortcuts.formatKeybinding(keybinding)
      return result.success ? result.data : ''
    } catch {
      return ''
    }
  },

  // Toggle Vim-style navigation
  toggleVimNavigation: () => {
    set((state) => ({ vimNavigationEnabled: !state.vimNavigationEnabled }))
  },

  // Clear error state
  clearError: () => {
    set({ error: null, conflictWarning: null })
  },

  // Open remap dialog for a shortcut
  openRemapDialog: (shortcut: KeyboardShortcut) => {
    set({
      remapDialogState: 'remap',
      remappingShortcut: shortcut,
      capturedKeybinding: null,
      conflictWarning: null
    })
  },

  // Close remap dialog
  closeRemapDialog: () => {
    set({
      remapDialogState: 'closed',
      remappingShortcut: null,
      capturedKeybinding: null,
      conflictWarning: null
    })
  },

  // Capture keybinding from user input
  captureKeybinding: (keybinding: Keybinding) => {
    set({ capturedKeybinding: keybinding, conflictWarning: null })
  },

  // Save the remapped shortcut
  saveRemappedShortcut: async () => {
    const { remappingShortcut, capturedKeybinding } = get()

    if (!remappingShortcut || !capturedKeybinding) {
      set({ error: 'No shortcut or keybinding to save' })
      return
    }

    await get().updateShortcut(remappingShortcut.id, capturedKeybinding)

    // Close dialog only if successful
    if (!get().error && !get().conflictWarning) {
      set({
        remapDialogState: 'closed',
        remappingShortcut: null,
        capturedKeybinding: null
      })
    }
  },

  // Get worktree operation shortcuts
  getWorktreeShortcuts: () => {
    return get().getShortcutsByCategory('worktree-operations')
  },

  // Get navigation shortcuts
  getNavigationShortcuts: () => {
    return get().getShortcutsByCategory('navigation')
  },

  // Get global shortcuts
  getGlobalShortcuts: () => {
    return get().getShortcutsByCategory('global')
  },

  // Get shortcuts by category
  getShortcutsByCategory: (category: ShortcutCategory) => {
    return get().shortcuts.filter(s => s.category === category)
  }
}))

// Selectors for optimized re-renders
export const useShortcuts = () => useKeyboardShortcutsStore((state) => state.shortcuts)
export const usePlatform = () => useKeyboardShortcutsStore((state) => state.platform)
export const useIsLoading = () => useKeyboardShortcutsStore((state) => state.isLoading)
export const useShortcutsError = () => useKeyboardShortcutsStore((state) => state.error)
export const useVimNavigationEnabled = () => useKeyboardShortcutsStore((state) => state.vimNavigationEnabled)
export const useRemapDialogState = () => useKeyboardShortcutsStore((state) => state.remapDialogState)
export const useRemappingShortcut = () => useKeyboardShortcutsStore((state) => state.remappingShortcut)
export const useCapturedKeybinding = () => useKeyboardShortcutsStore((state) => state.capturedKeybinding)
export const useConflictWarning = () => useKeyboardShortcutsStore((state) => state.conflictWarning)

// Combined selectors
export const useShortcutsState = () => useKeyboardShortcutsStore((state) => ({
  shortcuts: state.shortcuts,
  platform: state.platform,
  isLoading: state.isLoading,
  error: state.error,
  vimNavigationEnabled: state.vimNavigationEnabled
}))

// Actions selector
export const useShortcutActions = () => useKeyboardShortcutsStore((state) => ({
  fetchShortcuts: state.fetchShortcuts,
  updateShortcut: state.updateShortcut,
  resetShortcuts: state.resetShortcuts,
  getShortcutForCommand: state.getShortcutForCommand,
  formatKeybinding: state.formatKeybinding,
  toggleVimNavigation: state.toggleVimNavigation,
  clearError: state.clearError,
  openRemapDialog: state.openRemapDialog,
  closeRemapDialog: state.closeRemapDialog,
  captureKeybinding: state.captureKeybinding,
  saveRemappedShortcut: state.saveRemappedShortcut,
  getWorktreeShortcuts: state.getWorktreeShortcuts,
  getNavigationShortcuts: state.getNavigationShortcuts,
  getGlobalShortcuts: state.getGlobalShortcuts,
  getShortcutsByCategory: state.getShortcutsByCategory
}))
