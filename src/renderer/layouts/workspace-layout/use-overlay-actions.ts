import { useCallback } from 'react'
import { getEffectiveThemeId } from '@/lib/themes'
import { useAppearanceMode, useColorTheme } from '@/stores/app-settings-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { useThemePickerStore } from '@/stores/theme-picker-store'

interface UseOverlayActionsOptions {
  setIsCommandPaletteOpen: (open: boolean) => void
  setIsShortcutMenuOpen: (open: boolean) => void
  setIsCreateSnapshotModalOpen: (open: boolean) => void
  setIsCommandHistoryOpen: (open: boolean) => void
}

/** Open/toggle handlers for the app overlays (snapshot, settings, history, shortcuts, theme picker). */
export function useOverlayActions({
  setIsCommandPaletteOpen,
  setIsShortcutMenuOpen,
  setIsCreateSnapshotModalOpen,
  setIsCommandHistoryOpen
}: UseOverlayActionsOptions) {
  const handleOpenSnapshotModal = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setIsCreateSnapshotModalOpen(true)
  }, [setIsCommandPaletteOpen, setIsCreateSnapshotModalOpen])

  const handleOpenProjectSettings = useCallback(() => {
    setIsCommandPaletteOpen(false)
    useSettingsModalStore.getState().openProject()
  }, [setIsCommandPaletteOpen])

  const handleOpenAppPreferences = useCallback(() => {
    setIsCommandPaletteOpen(false)
    if (useThemePickerStore.getState().isOpen) {
      useThemePickerStore.getState().cancel()
    }
    useSettingsModalStore.getState().openApp()
  }, [setIsCommandPaletteOpen])

  const handleOpenCommandHistory = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setIsCommandHistoryOpen(true)
  }, [setIsCommandPaletteOpen, setIsCommandHistoryOpen])

  const handleOpenShortcutMenu = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setIsShortcutMenuOpen(true)
  }, [setIsCommandPaletteOpen, setIsShortcutMenuOpen])

  const colorTheme = useColorTheme()
  const appearanceMode = useAppearanceMode()

  const closeThemePickerPeerOverlays = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setIsShortcutMenuOpen(false)
    setIsCommandHistoryOpen(false)
    // Close the settings modal too — the old code closed the /preferences
    // route via navigate('/') before opening the theme picker. The route is
    // gone, so close the modal via the store (EdgeCaseHunter #3).
    useSettingsModalStore.getState().close()
  }, [setIsCommandPaletteOpen, setIsShortcutMenuOpen, setIsCommandHistoryOpen])

  const handleToggleThemePicker = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    closeThemePickerPeerOverlays()
    useThemePickerStore.getState().toggle(getEffectiveThemeId(colorTheme, appearanceMode))
  }, [appearanceMode, closeThemePickerPeerOverlays, colorTheme])

  const handleOpenThemePicker = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    closeThemePickerPeerOverlays()
    const store = useThemePickerStore.getState()
    if (!store.isOpen) {
      store.open(getEffectiveThemeId(colorTheme, appearanceMode))
    }
  }, [appearanceMode, closeThemePickerPeerOverlays, colorTheme])

  return {
    handleOpenSnapshotModal,
    handleOpenProjectSettings,
    handleOpenAppPreferences,
    handleOpenCommandHistory,
    handleOpenShortcutMenu,
    handleToggleThemePicker,
    handleOpenThemePicker
  }
}
