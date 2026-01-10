import { describe, it, expect, beforeEach } from 'vitest'
import { useKeyboardShortcutsStore, findConflictingShortcut, normalizeKeyEvent, formatKeyForDisplay, matchesShortcut } from './keyboard-shortcuts-store'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@/types/settings'

describe('keyboard-shortcuts-store', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    const defaults: Record<string, typeof DEFAULT_KEYBOARD_SHORTCUTS[keyof typeof DEFAULT_KEYBOARD_SHORTCUTS]> = {}
    for (const [key, shortcut] of Object.entries(DEFAULT_KEYBOARD_SHORTCUTS)) {
      defaults[key] = { ...shortcut }
    }
    useKeyboardShortcutsStore.setState({
      shortcuts: defaults,
      isLoaded: false
    })
  })

  describe('initial state', () => {
    it('should have all default shortcuts', () => {
      const { shortcuts } = useKeyboardShortcutsStore.getState()
      expect(Object.keys(shortcuts).length).toBe(Object.keys(DEFAULT_KEYBOARD_SHORTCUTS).length)
    })

    it('should have commandPalette shortcut with default key', () => {
      const { shortcuts } = useKeyboardShortcutsStore.getState()
      expect(shortcuts.commandPalette.defaultKey).toBe('ctrl+k')
      expect(shortcuts.commandPalette.customKey).toBeUndefined()
    })

    it('should have isLoaded as false initially', () => {
      const { isLoaded } = useKeyboardShortcutsStore.getState()
      expect(isLoaded).toBe(false)
    })
  })

  describe('updateShortcut', () => {
    it('should update customKey for a shortcut', () => {
      const { updateShortcut } = useKeyboardShortcutsStore.getState()

      updateShortcut('commandPalette', 'ctrl+j')

      const { shortcuts } = useKeyboardShortcutsStore.getState()
      expect(shortcuts.commandPalette.customKey).toBe('ctrl+j')
      expect(shortcuts.commandPalette.defaultKey).toBe('ctrl+k') // unchanged
    })

    it('should clear customKey when set to same as default', () => {
      const { updateShortcut } = useKeyboardShortcutsStore.getState()

      // First set a custom key
      updateShortcut('commandPalette', 'ctrl+j')
      expect(useKeyboardShortcutsStore.getState().shortcuts.commandPalette.customKey).toBe('ctrl+j')

      // Then set it back to default
      updateShortcut('commandPalette', 'ctrl+k')
      expect(useKeyboardShortcutsStore.getState().shortcuts.commandPalette.customKey).toBeUndefined()
    })

    it('should not affect other shortcuts when updating one', () => {
      const { updateShortcut } = useKeyboardShortcutsStore.getState()

      updateShortcut('commandPalette', 'ctrl+j')

      const { shortcuts } = useKeyboardShortcutsStore.getState()
      expect(shortcuts.terminalSearch.customKey).toBeUndefined()
      expect(shortcuts.terminalSearch.defaultKey).toBe('ctrl+f')
    })
  })

  describe('resetShortcut', () => {
    it('should reset a single shortcut to default', () => {
      const { updateShortcut, resetShortcut } = useKeyboardShortcutsStore.getState()

      // Set custom key
      updateShortcut('commandPalette', 'ctrl+j')
      expect(useKeyboardShortcutsStore.getState().shortcuts.commandPalette.customKey).toBe('ctrl+j')

      // Reset it
      resetShortcut('commandPalette')
      expect(useKeyboardShortcutsStore.getState().shortcuts.commandPalette.customKey).toBeUndefined()
    })

    it('should not affect other shortcuts when resetting one', () => {
      const { updateShortcut, resetShortcut } = useKeyboardShortcutsStore.getState()

      // Set custom keys for two shortcuts
      updateShortcut('commandPalette', 'ctrl+j')
      updateShortcut('terminalSearch', 'ctrl+g')

      // Reset only one
      resetShortcut('commandPalette')

      const { shortcuts } = useKeyboardShortcutsStore.getState()
      expect(shortcuts.commandPalette.customKey).toBeUndefined()
      expect(shortcuts.terminalSearch.customKey).toBe('ctrl+g')
    })
  })

  describe('resetAllShortcuts', () => {
    it('should reset all shortcuts to defaults', () => {
      const { updateShortcut, resetAllShortcuts } = useKeyboardShortcutsStore.getState()

      // Set custom keys for multiple shortcuts
      updateShortcut('commandPalette', 'ctrl+j')
      updateShortcut('terminalSearch', 'ctrl+g')
      updateShortcut('newProject', 'ctrl+m')

      // Reset all
      resetAllShortcuts()

      const { shortcuts } = useKeyboardShortcutsStore.getState()
      expect(shortcuts.commandPalette.customKey).toBeUndefined()
      expect(shortcuts.terminalSearch.customKey).toBeUndefined()
      expect(shortcuts.newProject.customKey).toBeUndefined()
    })
  })

  describe('setShortcuts', () => {
    it('should replace all shortcuts and set isLoaded to true', () => {
      const newShortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS }
      newShortcuts.commandPalette = { ...newShortcuts.commandPalette, customKey: 'ctrl+j' }

      const { setShortcuts } = useKeyboardShortcutsStore.getState()
      setShortcuts(newShortcuts)

      const { shortcuts, isLoaded } = useKeyboardShortcutsStore.getState()
      expect(shortcuts.commandPalette.customKey).toBe('ctrl+j')
      expect(isLoaded).toBe(true)
    })
  })
})

describe('findConflictingShortcut', () => {
  it('should find a conflicting shortcut', () => {
    const shortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS }

    // Try to set terminalSearch to same key as commandPalette
    const conflict = findConflictingShortcut(shortcuts, 'ctrl+k', 'terminalSearch')
    expect(conflict).toBeDefined()
    expect(conflict?.id).toBe('commandPalette')
  })

  it('should not find conflict for same shortcut', () => {
    const shortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS }

    // Setting commandPalette to its own key should not conflict
    const conflict = findConflictingShortcut(shortcuts, 'ctrl+k', 'commandPalette')
    expect(conflict).toBeUndefined()
  })

  it('should not find conflict for unique key', () => {
    const shortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS }

    const conflict = findConflictingShortcut(shortcuts, 'ctrl+m', 'commandPalette')
    expect(conflict).toBeUndefined()
  })

  it('should find conflict with customKey', () => {
    const shortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS }
    shortcuts.terminalSearch = { ...shortcuts.terminalSearch, customKey: 'ctrl+j' }

    const conflict = findConflictingShortcut(shortcuts, 'ctrl+j', 'commandPalette')
    expect(conflict).toBeDefined()
    expect(conflict?.id).toBe('terminalSearch')
  })
})

describe('normalizeKeyEvent', () => {
  it('should normalize a simple ctrl+key combination', () => {
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
    expect(normalizeKeyEvent(event)).toBe('ctrl+k')
  })

  it('should normalize ctrl+shift combination', () => {
    const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true })
    expect(normalizeKeyEvent(event)).toBe('ctrl+shift+p')
  })

  it('should handle Tab key', () => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true })
    expect(normalizeKeyEvent(event)).toBe('ctrl+tab')
  })

  it('should handle meta key as ctrl', () => {
    const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true })
    expect(normalizeKeyEvent(event)).toBe('ctrl+k')
  })
})

describe('formatKeyForDisplay', () => {
  it('should format ctrl+k for display', () => {
    // Platform-dependent, but should contain the key
    const result = formatKeyForDisplay('ctrl+k')
    expect(result).toContain('K')
  })

  it('should format ctrl+shift+p for display', () => {
    const result = formatKeyForDisplay('ctrl+shift+p')
    expect(result).toContain('P')
  })

  it('should handle empty string', () => {
    expect(formatKeyForDisplay('')).toBe('')
  })
})

describe('matchesShortcut', () => {
  it('should match a simple shortcut', () => {
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
    expect(matchesShortcut(event, 'ctrl+k')).toBe(true)
  })

  it('should not match different key', () => {
    const event = new KeyboardEvent('keydown', { key: 'j', ctrlKey: true })
    expect(matchesShortcut(event, 'ctrl+k')).toBe(false)
  })

  it('should not match missing modifier', () => {
    const event = new KeyboardEvent('keydown', { key: 'k' })
    expect(matchesShortcut(event, 'ctrl+k')).toBe(false)
  })

  it('should match with shift modifier', () => {
    const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true })
    expect(matchesShortcut(event, 'ctrl+shift+p')).toBe(true)
  })
})
