/**
 * Keyboard Shortcuts Manager Service
 *
 * Core service for managing keyboard shortcuts with conflict detection,
 * platform-specific handling, and persistence.
 *
 * Source: Story 3.3 - Keyboard Shortcuts System
 */

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { app } from 'electron'
import type {
  KeyboardShortcut,
  Keybinding,
  ShortcutConflict,
  ShortcutRemapResult,
  KeyboardShortcutSettings,
  ShortcutCategory
} from '../../shared/types/keyboard-shortcuts.types'

// Get platform from process
const currentPlatform = process.platform as NodeJS.Platform

import { KeyboardShortcutErrorCode } from '../../shared/types/keyboard-shortcuts.types'

/**
 * Keyboard Shortcut-specific error class
 */
export class KeyboardShortcutError extends Error {
  constructor(
    public code: string,
    message: string,
    public action?: string
  ) {
    super(message)
    this.name = 'KeyboardShortcutError'
  }
}

/**
 * Reserved system shortcuts that cannot be overridden
 */
const RESERVED_SHORTCUTS: Set<string> = new Set([
  'Cmd+Q',           // Quit app (macOS)
  'Cmd+Shift+Q',     // Quit app (macOS)
  'Alt+F4',          // Close window (Windows)
  'Ctrl+Alt+Delete', // Task Manager (Windows)
  'Cmd+Option+Esc',  // Force Quit (macOS)
  'Ctrl+Shift+Esc'   // Task Manager (Windows)
])

/**
 * Default keyboard shortcuts for worktree operations
 */
const DEFAULT_SHORTCUTS: KeyboardShortcut[] = [
  // Worktree Operations
  {
    id: 'worktree.create',
    command: 'worktree:create',
    description: 'Create new worktree',
    defaultKeybinding: { modifier: 'cmd', key: 'n' },
    currentUserKeybinding: { modifier: 'cmd', key: 'n' },
    category: 'worktree-operations',
    isEditable: true
  },
  {
    id: 'worktree.delete',
    command: 'worktree:delete',
    description: 'Delete selected worktree',
    defaultKeybinding: { modifier: 'cmd', key: 'd' },
    currentUserKeybinding: { modifier: 'cmd', key: 'd' },
    category: 'worktree-operations',
    isEditable: true
  },
  {
    id: 'worktree.archive',
    command: 'worktree:archive',
    description: 'Archive selected worktree',
    defaultKeybinding: { modifier: 'cmd', key: 'a' },
    currentUserKeybinding: { modifier: 'cmd', key: 'a' },
    category: 'worktree-operations',
    isEditable: true
  },
  {
    id: 'worktree.merge',
    command: 'worktree:merge',
    description: 'Merge selected worktree',
    defaultKeybinding: { modifier: 'cmd', key: 'm' },
    currentUserKeybinding: { modifier: 'cmd', key: 'm' },
    category: 'worktree-operations',
    isEditable: true
  },
  {
    id: 'worktree.open-terminal',
    command: 'worktree:open-terminal',
    description: 'Open terminal for selected worktree',
    defaultKeybinding: { modifier: 'cmd', key: 't' },
    currentUserKeybinding: { modifier: 'cmd', key: 't' },
    category: 'worktree-operations',
    isEditable: true
  },
  {
    id: 'worktree.restore',
    command: 'worktree:restore',
    description: 'Restore archived worktree',
    defaultKeybinding: { modifier: 'cmd', key: 'r' },
    currentUserKeybinding: { modifier: 'cmd', key: 'r' },
    category: 'worktree-operations',
    isEditable: true
  },

  // Navigation
  {
    id: 'nav.search',
    command: 'nav:search',
    description: 'Focus worktree search',
    defaultKeybinding: { modifier: 'cmd', key: 's' },
    currentUserKeybinding: { modifier: 'cmd', key: 's' },
    category: 'navigation',
    isEditable: true
  },
  {
    id: 'nav.toggle-grouping',
    command: 'nav:toggle-grouping',
    description: 'Toggle worktree grouping',
    defaultKeybinding: { modifier: 'cmd', key: 'g' },
    currentUserKeybinding: { modifier: 'cmd', key: 'g' },
    category: 'navigation',
    isEditable: true
  },

  // Global (Command Palette - not editable)
  {
    id: 'global.command-palette',
    command: 'global:command-palette',
    description: 'Open Command Palette',
    defaultKeybinding: { modifier: 'cmd', key: 'p' },
    currentUserKeybinding: { modifier: 'cmd', key: 'p' },
    category: 'global',
    isEditable: false
  }
]

/**
 * Keyboard Shortcuts Manager Service
 *
 * Manages keyboard shortcut configuration, validation, and persistence.
 * Handles platform-specific modifiers and conflict detection.
 *
 * @example
 * ```typescript
 * const manager = new KeyboardShortcutsManager()
 * const shortcuts = await manager.listShortcuts()
 * const result = await manager.updateShortcut('worktree.create', { modifier: 'cmd', key: 'n' })
 * ```
 */
export class KeyboardShortcutsManager {
  private shortcuts: Map<string, KeyboardShortcut>
  private readonly settingsPath: string
  private readonly platform: NodeJS.Platform

  constructor() {
    this.shortcuts = new Map()
    this.settingsPath = path.join(app.getPath('userData'), 'keyboard-shortcuts.json')
    this.platform = currentPlatform

    this.loadSettings()
  }

  /**
   * List all keyboard shortcuts
   *
   * @returns Array of all keyboard shortcuts
   */
  async listShortcuts(): Promise<KeyboardShortcut[]> {
    return Array.from(this.shortcuts.values())
  }

  /**
   * Update a keyboard shortcut with conflict detection
   *
   * Implements AC4: Shortcut Remapping with Conflict Detection
   *
   * @param shortcutId - ID of shortcut to update
   * @param keybinding - New keybinding to apply
   * @returns Result of the remap operation
   */
  async updateShortcut(shortcutId: string, keybinding: Keybinding): Promise<ShortcutRemapResult> {
    const shortcut = this.shortcuts.get(shortcutId)
    if (!shortcut) {
      return {
        success: false,
        error: `Shortcut '${shortcutId}' not found`
      }
    }

    // Check if shortcut is editable
    if (!shortcut.isEditable) {
      return {
        success: false,
        error: `Shortcut '${shortcutId}' is not editable`
      }
    }

    // Check if keybinding is reserved
    const keybindingStr = this.formatKeybinding(keybinding)
    if (RESERVED_SHORTCUTS.has(keybindingStr)) {
      return {
        success: false,
        error: `Keybinding '${keybindingStr}' is reserved and cannot be used`
      }
    }

    // Check for conflicts with other shortcuts
    const conflict = this.detectConflict(keybinding, shortcutId)
    if (conflict) {
      return {
        success: false,
        conflict
      }
    }

    // Update the shortcut
    shortcut.currentUserKeybinding = keybinding
    this.shortcuts.set(shortcutId, shortcut)

    // Persist to disk
    await this.saveSettings()

    return { success: true }
  }

  /**
   * Reset all shortcuts to defaults
   *
   * @returns Array of reset shortcuts
   */
  async resetToDefaults(): Promise<KeyboardShortcut[]> {
    this.shortcuts.clear()

    DEFAULT_SHORTCUTS.forEach((shortcut) => {
      // Clone the shortcut to avoid modifying the default
      this.shortcuts.set(shortcut.id, { ...shortcut })
    })

    await this.saveSettings()

    return Array.from(this.shortcuts.values())
  }

  /**
   * Get shortcut for a specific command
   *
   * @param command - Command string to look up
   * @returns Keyboard shortcut or undefined
   */
  getShortcutForCommand(command: string): KeyboardShortcut | undefined {
    const shortcutsArray = Array.from(this.shortcuts.values())

    for (const shortcut of shortcutsArray) {
      if (shortcut.command === command) {
        return shortcut
      }
    }
    return undefined
  }

  /**
   * Format a keybinding for display (platform-specific)
   *
   * Implements AC8: Platform-Specific Modifiers
   *
   * @param keybinding - Keybinding to format
   * @returns Formatted keybinding string
   */
  formatKeybinding(keybinding: Keybinding): string {
    const { modifier, key } = keybinding

    // On macOS, Cmd stays as Cmd; on Windows/Linux, Cmd becomes Ctrl
    let displayModifier = modifier
    if (modifier === 'cmd' && this.platform !== 'darwin') {
      displayModifier = 'ctrl'
    }

    // Capitalize first letter of modifier
    const formattedModifier = displayModifier.charAt(0).toUpperCase() + displayModifier.slice(1)

    // Capitalize the key
    const formattedKey = key.charAt(0).toUpperCase() + key.slice(1)

    return `${formattedModifier}+${formattedKey}`
  }

  /**
   * Detect if a keybinding conflicts with an existing shortcut
   *
   * @param keybinding - Keybinding to check
   * @param excludeId - Shortcut ID to exclude from conflict check
   * @returns Conflict info or undefined
   */
  private detectConflict(keybinding: Keybinding, excludeId: string): ShortcutConflict | undefined {
    const shortcutsArray = Array.from(this.shortcuts.values())

    for (const shortcut of shortcutsArray) {
      if (shortcut.id === excludeId) {
        continue
      }

      const existingBinding = shortcut.currentUserKeybinding
      if (
        existingBinding.modifier === keybinding.modifier &&
        existingBinding.key.toLowerCase() === keybinding.key.toLowerCase()
      ) {
        return {
          existingShortcut: shortcut,
          conflictingShortcut: this.shortcuts.get(excludeId)!
        }
      }
    }

    return undefined
  }

  /**
   * Load settings from disk
   */
  private async loadSettings(): Promise<void> {
    try {
      const data = await fs.readFile(this.settingsPath, 'utf-8')
      const settings: KeyboardShortcutSettings = JSON.parse(data)

      // Load shortcuts from settings
      this.shortcuts.clear()
      for (const shortcut of settings.shortcuts) {
        this.shortcuts.set(shortcut.id, shortcut)
      }
    } catch (error) {
      // If file doesn't exist or is invalid, use defaults
      await this.resetToDefaults()
    }
  }

  /**
   * Save settings to disk
   */
  private async saveSettings(): Promise<void> {
    const settings: KeyboardShortcutSettings = {
      shortcuts: Array.from(this.shortcuts.values()),
      vimNavigationEnabled: false, // Will be stored separately
      platform: this.platform as any
    }

    await fs.writeFile(this.settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
  }
}
