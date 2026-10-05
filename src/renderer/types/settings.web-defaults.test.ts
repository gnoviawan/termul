import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultKeyboardShortcuts } from '@/types/settings'

// Issue #858: Chrome/Edge reserve Ctrl+N/T/W, Ctrl+Shift+N, Ctrl+PageUp/Down
// and Ctrl+R in a normal tab; Ctrl+=/-/0 are the browser zoom keys. The web
// default bindings must swap those to Alt-based (or unbound) alternates while
// every other default stays identical, and the desktop table stays untouched.
//
// `getDefaultKeyboardShortcuts` detects the desktop runtime via
// `window.__TAURI_INTERNALS__`; stub the global per test to pick the branch.
describe('getDefaultKeyboardShortcuts (#858 web-safe defaults)', () => {
  afterEach(() => {
    // @ts-expect-error test cleanup deletes the injected global
    delete window.__TAURI_INTERNALS__
  })

  it('desktop: returns the unchanged Ctrl-based defaults', () => {
    ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}

    const defaults = getDefaultKeyboardShortcuts()

    expect(defaults.newProject.defaultKey).toBe('ctrl+n')
    expect(defaults.newTerminal.defaultKey).toBe('ctrl+t')
    expect(defaults.newBrowserTab.defaultKey).toBe('ctrl+shift+n')
    expect(defaults.closeTab.defaultKey).toBe('ctrl+w')
    expect(defaults.nextTerminal.defaultKey).toBe('ctrl+pagedown')
    expect(defaults.prevTerminal.defaultKey).toBe('ctrl+pageup')
    expect(defaults.commandHistory.defaultKey).toBe('ctrl+r')
    expect(defaults.zoomIn.defaultKey).toBe('ctrl+=')
    expect(defaults.zoomOut.defaultKey).toBe('ctrl+-')
    expect(defaults.zoomReset.defaultKey).toBe('ctrl+0')
  })

  it('web: remaps browser-reserved combos to Alt-based alternates', () => {
    const defaults = getDefaultKeyboardShortcuts()

    expect(defaults.newProject.defaultKey).toBe('alt+n')
    expect(defaults.newTerminal.defaultKey).toBe('alt+t')
    expect(defaults.newBrowserTab.defaultKey).toBe('alt+shift+n')
    expect(defaults.closeTab.defaultKey).toBe('alt+w')
    expect(defaults.nextTerminal.defaultKey).toBe('alt+pagedown')
    expect(defaults.prevTerminal.defaultKey).toBe('alt+pageup')
    expect(defaults.zoomIn.defaultKey).toBe('alt+=')
    expect(defaults.zoomOut.defaultKey).toBe('alt+-')
    expect(defaults.zoomReset.defaultKey).toBe('alt+0')
  })

  it('web: leaves Ctrl+R unbound (browser reload) instead of remapping', () => {
    const defaults = getDefaultKeyboardShortcuts()

    // Empty default never matches a normalized event — the browser keeps
    // Ctrl+R for reload and the user can bind a custom replacement.
    expect(defaults.commandHistory.defaultKey).toBe('')
  })

  it('web: keeps every non-reserved default identical and preserves metadata', () => {
    const defaults = getDefaultKeyboardShortcuts()

    expect(defaults.commandPalette.defaultKey).toBe('ctrl+k')
    expect(defaults.commandPaletteAlt.defaultKey).toBe('ctrl+shift+p')
    expect(defaults.terminalSearch.defaultKey).toBe('ctrl+f')
    expect(defaults.sidebarToggle.defaultKey).toBe('ctrl+shift+b')
    expect(defaults.saveFile.defaultKey).toBe('ctrl+s')
    expect(defaults.toggleFileExplorer.defaultKey).toBe('ctrl+b')
    expect(defaults.colorThemePicker.defaultKey).toBe('ctrl+alt+t')
    expect(defaults.newTerminal.id).toBe('newTerminal')
    expect(defaults.newTerminal.label).toBe('Agent Launcher')
    expect(defaults.newTerminal.customKey).toBeUndefined()
  })

  it('web: Alt-based alternates do not collide with other defaults', () => {
    const defaults = getDefaultKeyboardShortcuts()

    const activeKeys = Object.values(defaults).map(
      (shortcut) => shortcut.customKey ?? shortcut.defaultKey
    )
    const nonEmpty = activeKeys.filter((key) => key.length > 0)
    const uniqueKeys = new Set(nonEmpty)
    expect(uniqueKeys.size).toBe(nonEmpty.length)
  })
})
