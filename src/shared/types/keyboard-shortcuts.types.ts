/**
 * Keyboard Shortcuts Types
 *
 * Type definitions for keyboard shortcut management and customization.
 * Source: Story 3.3 - Keyboard Shortcuts System
 */

/**
 * Platform-specific modifier keys
 * - cmd: Command key (macOS) or Ctrl key (Windows/Linux)
 * - ctrl: Control key (for platform-independent shortcuts)
 * - alt: Option/Alt key
 * - shift: Shift key
 * - meta: Meta/Windows key (rarely used)
 */
export type ModifierKey = 'cmd' | 'ctrl' | 'alt' | 'shift' | 'meta'

/**
 * Supported platforms for platform-specific shortcuts
 */
export type ShortcutPlatform = 'darwin' | 'win32' | 'linux'

/**
 * Keybinding definition
 * Defines a keyboard shortcut with modifier(s) and key
 */
export interface Keybinding {
  modifier: ModifierKey
  key: string
  platform?: ShortcutPlatform  // undefined = all platforms
}

/**
 * Shortcut categories for organization
 */
export type ShortcutCategory =
  | 'worktree-operations'
  | 'navigation'
  | 'dialogs'
  | 'global'

/**
 * Keyboard shortcut definition
 */
export interface KeyboardShortcut {
  id: string
  command: string
  description: string
  defaultKeybinding: Keybinding
  currentUserKeybinding: Keybinding
  category: ShortcutCategory
  isEditable: boolean
}

/**
 * Conflict detected when remapping a shortcut
 */
export interface ShortcutConflict {
  existingShortcut: KeyboardShortcut
  conflictingShortcut: KeyboardShortcut
}

/**
 * Result of a shortcut remap operation
 */
export interface ShortcutRemapResult {
  success: boolean
  conflict?: ShortcutConflict
  error?: string
}

// ============================================================================
// DTOs for IPC Communication
// ============================================================================

/**
 * DTO for updating a keyboard shortcut
 */
export interface UpdateShortcutDto {
  shortcutId: string
  keybinding: Keybinding
}

/**
 * DTO for registering a keyboard shortcut at runtime
 */
export interface RegisterShortcutDto {
  shortcut: KeyboardShortcut
}

/**
 * DTO for unregistering a keyboard shortcut
 */
export interface UnregisterShortcutDto {
  shortcutId: string
}

// ============================================================================
// Keyboard Shortcut Settings
// ============================================================================

/**
 * User preferences for keyboard shortcuts
 */
export interface KeyboardShortcutSettings {
  shortcuts: KeyboardShortcut[]
  vimNavigationEnabled: boolean
  platform: ShortcutPlatform
}

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Keyboard shortcut error codes
 */
export const KeyboardShortcutErrorCode = {
  SHORTCUT_NOT_FOUND: 'SHORTCUT_NOT_FOUND',
  SHORTCUT_ALREADY_EXISTS: 'SHORTCUT_ALREADY_EXISTS',
  SHORTCUT_CONFLICT: 'SHORTCUT_CONFLICT',
  RESERVED_SHORTCUT: 'RESERVED_SHORTCUT',
  INVALID_KEYBINDING: 'INVALID_KEYBINDING',
  SAVE_FAILED: 'SAVE_FAILED',
  LOAD_FAILED: 'LOAD_FAILED'
} as const

export type KeyboardShortcutErrorCodeType = (typeof KeyboardShortcutErrorCode)[keyof typeof KeyboardShortcutErrorCode]
