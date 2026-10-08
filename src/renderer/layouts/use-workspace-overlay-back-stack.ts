import { useEffect, useRef } from 'react'
import {
  installOverlayBackHandler,
  type OverlayRegistrationOptions,
  pushOverlaySentinel,
  useOverlayRegistration,
  useOverlayStackStore
} from '@/stores/overlay-stack-store'
import { useSettingsModalStore, useSettingsModalView } from '@/stores/settings-modal-store'
import { useThemePickerOpen, useThemePickerStore } from '@/stores/theme-picker-store'
import { findPaneById, useWorkspaceStore } from '@/stores/workspace-store'

interface WorkspaceOverlayBackStackArgs {
  /** `useMobileWebShell()` — drives the mobile-shell flag in the overlay store. */
  isMobileWebShell: boolean
  gitSheetOpen: boolean
  setGitSheetOpen: (open: boolean) => void
  isCommandPaletteOpen: boolean
  setIsCommandPaletteOpen: (open: boolean) => void
  isCommandHistoryOpen: boolean
  setIsCommandHistoryOpen: (open: boolean) => void
  isSshPasswordPromptOpen: boolean
  /** Clears the SSH password prompt and its input, as its Cancel button does. */
  closeSshPasswordPrompt: () => void
}

/** Registrations that only apply while the mobile web shell is active. */
const MOBILE_SHELL_ONLY: OverlayRegistrationOptions = { mobileShellOnly: true }

/**
 * The AgentLauncher is an overlay only when its pane already has tabs; an
 * empty pane renders it as the pane body (see `PaneContent`), which is not an
 * overlay and must not take a history sentinel.
 */
function selectAgentLauncherOverlayOpen(
  state: Pick<ReturnType<typeof useWorkspaceStore.getState>, 'agentLauncherPaneId' | 'root'>
): boolean {
  if (state.agentLauncherPaneId === null) return false
  const pane = findPaneById(state.root, state.agentLauncherPaneId)
  return pane?.type === 'leaf' && pane.tabs.length > 0
}

/**
 * Overlay back stack wiring for `WorkspaceLayout` (Story 6 + mobile overlay
 * back stack): hardware / browser back closes the topmost overlay, and an
 * overlay closed by X, Esc or its scrim never leaves a dead back press.
 *
 * Owns the overlays whose open state lives in WorkspaceLayout or its stores
 * (several are lazy-mounted, so registering at the owner keeps a palette →
 * sub-modal swap inside one flush), syncs the mobile-shell flag, and installs
 * the app-root back handler once. Shared shells (`ui/dialog`, `ConfirmDialog`,
 * ...) register themselves.
 */
export function useWorkspaceOverlayBackStack({
  isMobileWebShell,
  gitSheetOpen,
  setGitSheetOpen,
  isCommandPaletteOpen,
  setIsCommandPaletteOpen,
  isCommandHistoryOpen,
  setIsCommandHistoryOpen,
  isSshPasswordPromptOpen,
  closeSshPasswordPrompt
}: WorkspaceOverlayBackStackArgs): void {
  const settingsModalOpen = useSettingsModalView() !== null
  const themePickerOpen = useThemePickerOpen()
  const agentLauncherOverlayOpen = useWorkspaceStore(selectAgentLauncherOverlayOpen)

  // Mobile-shell flag first, so it is set before the registrations' effects
  // and the handler's install below.
  useEffect(() => {
    useOverlayStackStore.getState().setMobileShell(isMobileWebShell)
  }, [isMobileWebShell])
  useEffect(
    () => () => {
      useOverlayStackStore.getState().setMobileShell(false)
    },
    []
  )

  // Every overlay visible on this layout registers itself (id + close) so
  // the app-root popstate handler can dismiss the topmost one on Android
  // hardware back instead of the browser exiting the app (QA F5).
  useOverlayRegistration('git-sheet', gitSheetOpen, () => setGitSheetOpen(false))
  useOverlayRegistration('command-palette', isCommandPaletteOpen, () =>
    setIsCommandPaletteOpen(false)
  )
  useOverlayRegistration('settings-modal', settingsModalOpen, () =>
    useSettingsModalStore.getState().close()
  )

  // Mobile shell only. Each close is the owner's own, so guards still run.
  useOverlayRegistration(
    'agent-launcher',
    agentLauncherOverlayOpen,
    () => useWorkspaceStore.getState().hideAgentLauncher(),
    MOBILE_SHELL_ONLY
  )
  useOverlayRegistration(
    'command-history',
    isCommandHistoryOpen,
    () => setIsCommandHistoryOpen(false),
    MOBILE_SHELL_ONLY
  )
  useOverlayRegistration(
    'theme-picker',
    themePickerOpen,
    // Reverts the preview and closes, the same as Esc.
    () => useThemePickerStore.getState().cancel(),
    MOBILE_SHELL_ONLY
  )
  useOverlayRegistration(
    'ssh-password-prompt',
    isSshPasswordPromptOpen,
    closeSshPasswordPrompt,
    MOBILE_SHELL_ONLY
  )

  // Legacy (desktop) path: the sentinel push happens when the stack grows so
  // the next back lands on a popstate we own. On the mobile shell the
  // reconciler in `installOverlayBackHandler` owns every push and traversal.
  const overlayCount = useOverlayStackStore((s) => s.stack.length)
  const prevOverlayCountRef = useRef(0)
  useEffect(() => {
    if (!isMobileWebShell && overlayCount > prevOverlayCountRef.current) {
      // Stack grew (0 → 1, or an overlay stacked on another): arm the
      // history sentinel so back pops an overlay, not the app.
      pushOverlaySentinel()
    }
    prevOverlayCountRef.current = overlayCount
  }, [overlayCount, isMobileWebShell])

  // App-root popstate listener: mounted once for the workspace surface. It is
  // the single install point for every route (`/`, `/c/:id` and `/snapshots`
  // are WorkspaceLayout's children in both App.tsx and TauriApp.tsx).
  useEffect(() => installOverlayBackHandler(), [])
}
