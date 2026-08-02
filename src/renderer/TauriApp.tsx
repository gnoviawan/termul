import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { Toaster } from '@/components/ui/toaster'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useWindowState } from '@/hooks/use-window-state'
import { getCurrentWindow } from '@/lib/tauri-window'
import { useUpdateToast } from './components/UpdateAvailableToast'
import { WhatsNewModal } from './components/WhatsNewModal'
import { useAcpAgents } from './hooks/use-acp-agents'
import { useAcpHistory } from './hooks/use-acp-history'
import { useAcpSessionResume } from './hooks/use-acp-session-resume'
import { useAcpListeners } from './hooks/use-acp-listeners'
import { useAcpMcp } from './hooks/use-acp-mcp'
import { useAppSettingsLoader } from './hooks/use-app-settings'
import { useAppliedColorThemeSync } from './hooks/use-color-theme'
import { useContextBarSettings } from './hooks/use-context-bar-settings'
import { useCrashRecovery } from './hooks/use-crash-recovery'
import { useCwd } from './hooks/use-cwd'
import { useExitCode } from './hooks/use-exit-code'
import { useGitBranch } from './hooks/use-git-branch'
import { useGitStatus } from './hooks/use-git-status'
import { useKeyboardShortcutsLoader } from './hooks/use-keyboard-shortcuts'
import { useMenuUpdaterListener } from './hooks/use-menu-updater-listener'
import { usePreventFileDropNavigation } from './hooks/use-prevent-file-drop-navigation'
import { useProjectsAutoSave, useProjectsLoader } from './hooks/use-projects-persistence'
import { useRemoteProjects } from './hooks/use-remote-projects'
import { useTerminalDetachedOutput } from './hooks/use-terminal-detached-output'
import { useTerminalExitNotification } from './hooks/use-terminal-exit-notification'
import { useTerminalRestore } from './hooks/use-terminal-restore'
import { useAppliedUiZoomSync } from './hooks/use-ui-zoom'
import { useUpdateCheck } from './hooks/use-updater'
import { useVisibilityState } from './hooks/use-visibility-state'
import { useWhatsNew } from './hooks/use-whats-new'
import { useTerminalAutoSave } from './hooks/useTerminalAutoSave'
import WorkspaceLayout from './layouts/WorkspaceLayout'
import { initNotificationPermissions } from './lib/tauri-notification-api'
import AppPreferences from './pages/AppPreferences'
import NotFound from './pages/NotFound'
import ProjectSettings from './pages/ProjectSettings'
import WorkspaceDashboard from './pages/WorkspaceDashboard'
import WorkspaceSnapshots from './pages/WorkspaceSnapshots'

const queryClient = new QueryClient()

// Prevent the default webview context menu (Inspect, Back, etc.) from appearing
// on right-click. Custom context menus (FileExplorer, ProjectSidebar) already
// call e.preventDefault() in their React handlers and render their own UI,
// so they are unaffected by this capture-phase listener.
function usePreventDefaultContextMenu(): void {
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      e.preventDefault()
    }
    document.addEventListener('contextmenu', handler, { capture: true })
    return () => document.removeEventListener('contextmenu', handler, { capture: true })
  }, [])
}

// Component to handle app-level effects like auto-save
function AppEffects(): null {
  useTerminalAutoSave()
  useTerminalRestore()
  useCrashRecovery()
  useTerminalDetachedOutput()
  useCwd()
  useGitBranch()
  useGitStatus()
  useExitCode()
  useContextBarSettings()
  useAppSettingsLoader()
  useAppliedColorThemeSync()
  useAppliedUiZoomSync()
  useKeyboardShortcutsLoader()
  useProjectsLoader()
  useProjectsAutoSave()
  useMenuUpdaterListener()
  useUpdateCheck()
  useUpdateToast()
  useVisibilityState()
  useTerminalExitNotification()
  useRemoteProjects()
  useAcpListeners()
  useAcpAgents()
  useAcpHistory()
  useAcpSessionResume()
  useAcpMcp()
  usePreventFileDropNavigation()
  usePreventDefaultContextMenu()

  // Initialize desktop notification permissions once at app startup
  // so the OS permission prompt appears early, not on first terminal exit
  useEffect(() => {
    initNotificationPermissions()
  }, [])

  return null
}

const router = createHashRouter(
  [
    {
      path: '/',
      element: <WorkspaceLayout />,
      children: [
        { index: true, element: <WorkspaceDashboard /> },
        { path: 'snapshots', element: <WorkspaceSnapshots /> },
        { path: 'settings', element: <ProjectSettings /> },
        { path: 'preferences', element: <AppPreferences /> }
      ]
    },
    { path: '*', element: <NotFound /> }
  ],
  {
    future: {
      v7_relativeSplatPath: true
    }
  }
)

export default function TauriApp(): React.JSX.Element {
  const isWindowStateReady = useWindowState()
  const whatsNew = useWhatsNew()

  useEffect(() => {
    if (!isWindowStateReady) return

    // Show window immediately after mount (only in Tauri context)
    const showWindow = async () => {
      if (typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ === 'undefined')
        return
      try {
        await getCurrentWindow().show()
      } catch (err) {
        console.error('Failed to show window:', err)
      }
    }

    showWindow()
  }, [isWindowStateReady])

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary context="App Root">
          <AppEffects />
          <Toaster />
          <Sonner />
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
          <WhatsNewModal
            isOpen={whatsNew.isOpen}
            version={whatsNew.version}
            notes={whatsNew.notes}
            htmlUrl={whatsNew.htmlUrl}
            onClose={whatsNew.close}
          />
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
