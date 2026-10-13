import { PersistenceKeys } from '@shared/types/persistence.types'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedFake } from '@/lib/__tests__/shared-watch-fake'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { usePinnedCommandsStore } from '@/stores/pinned-commands-store'
import { useTocSettingsStore } from '@/stores/toc-settings-store'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_CONTEXT_BAR_SETTINGS,
  DEFAULT_TOC_SETTINGS,
  getDefaultKeyboardShortcuts
} from '@/types/settings'
import { useAppSettingsLoader } from './use-app-settings'
import { useContextBarSettings } from './use-context-bar-settings'
import { useKeyboardShortcutsLoader } from './use-keyboard-shortcuts'
import { usePinnedCommandsLoader } from './use-pinned-commands'
import { useTocSettings } from './use-toc-settings'

vi.mock('@/lib/api', async () => ({
  persistenceApi: (await import('@/lib/__tests__/shared-watch-fake')).sharedFake.api,
  acpApi: {
    setTurnTimeout: vi.fn(),
    setTurnIdleTimeout: vi.fn(),
    setSessionNewTimeout: vi.fn(),
    setSessionReopenTimeout: vi.fn()
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

describe('shared settings keys reach their stores from another device', () => {
  beforeEach(() => {
    sharedFake.reset()
  })

  it('app settings: a remote value replaces the store settings, merged with defaults', async () => {
    sharedFake.seed(PersistenceKeys.appSettings, { ...DEFAULT_APP_SETTINGS, terminalFontSize: 12 })
    useAppSettingsStore.setState({ settings: DEFAULT_APP_SETTINGS, isLoaded: false })
    renderHook(() => useAppSettingsLoader())
    await waitFor(() => expect(useAppSettingsStore.getState().isLoaded).toBe(true))

    sharedFake.remote(PersistenceKeys.appSettings, {
      terminalFontSize: 19,
      appearanceMode: 'light'
    })

    const settings = useAppSettingsStore.getState().settings
    expect(settings.terminalFontSize).toBe(19)
    expect(settings.appearanceMode).toBe('light')
    expect(settings.colorTheme).toBe(DEFAULT_APP_SETTINGS.colorTheme)
    expect(sharedFake.api.writeDebounced).not.toHaveBeenCalled()
  })

  it('keyboard shortcuts: a remote custom key is applied over the defaults', async () => {
    renderHook(() => useKeyboardShortcutsLoader())
    await waitFor(() => expect(sharedFake.api.read).toHaveBeenCalled())
    const [id] = Object.keys(getDefaultKeyboardShortcuts())

    sharedFake.remote(PersistenceKeys.keyboardShortcuts, { [id]: { customKey: 'Alt+Shift+Q' } })

    expect(useKeyboardShortcutsStore.getState().shortcuts[id].customKey).toBe('Alt+Shift+Q')
    expect(sharedFake.api.writeDebounced).not.toHaveBeenCalled()
  })

  it('context bar: a remote value is applied with the always-on project name default', async () => {
    renderHook(() => useContextBarSettings())
    await waitFor(() => expect(useContextBarSettingsStore.getState().isLoaded).toBe(true))

    sharedFake.remote(PersistenceKeys.contextBarSettings, { showGitBranch: false })

    const settings = useContextBarSettingsStore.getState().settings
    expect(settings.showGitBranch).toBe(false)
    expect(settings.showProjectName).toBe(true)
    expect(settings.showExitCode).toBe(DEFAULT_CONTEXT_BAR_SETTINGS.showExitCode)
  })

  it('pinned commands: a remote list is applied, a corrupt one is not', async () => {
    renderHook(() => usePinnedCommandsLoader())
    await waitFor(() => expect(sharedFake.api.read).toHaveBeenCalled())

    sharedFake.remote(PersistenceKeys.pinnedCommands, ['a', 'b'])
    expect(usePinnedCommandsStore.getState().pinnedCommandIds).toEqual(['a', 'b'])

    sharedFake.remote(PersistenceKeys.pinnedCommands, ['a', 3])
    expect(usePinnedCommandsStore.getState().pinnedCommandIds).toEqual(['a', 'b'])
    expect(sharedFake.api.write).not.toHaveBeenCalled()
  })

  it('toc settings: a remote value is applied and not saved back', async () => {
    useTocSettingsStore.setState({ settings: DEFAULT_TOC_SETTINGS, isLoaded: false })
    renderHook(() => useTocSettings())
    await waitFor(() => expect(useTocSettingsStore.getState().isLoaded).toBe(true))
    sharedFake.api.writeDebounced.mockClear()

    sharedFake.remote(PersistenceKeys.tocSettings, { ...DEFAULT_TOC_SETTINGS, isVisible: false })

    expect(useTocSettingsStore.getState().settings).toMatchObject({ isVisible: false })
    expect(sharedFake.api.writeDebounced).not.toHaveBeenCalled()
  })
})
