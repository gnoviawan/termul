import { useEffect } from 'react'
import { Toaster } from '@/components/ui/toaster'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useWindowState } from '@/hooks/use-window-state'
import WorkspaceLayout from './layouts/WorkspaceLayout'
import WorkspaceDashboard from './pages/WorkspaceDashboard'
import ProjectSettings from './pages/ProjectSettings'
import AppPreferences from './pages/AppPreferences'
import WorkspaceSnapshots from './pages/WorkspaceSnapshots'
import NotFound from './pages/NotFound'
import { useTerminalAutoSave } from './hooks/useTerminalAutoSave'
import { useTerminalRestore } from './hooks/use-terminal-restore'
import { useTerminalDetachedOutput } from './hooks/use-terminal-detached-output'
import { useCwd } from './hooks/use-cwd'
import { useGitBranch } from './hooks/use-git-branch'
import { useGitStatus } from './hooks/use-git-status'
import { useExitCode } from './hooks/use-exit-code'
import { useContextBarSettings } from './hooks/use-context-bar-settings'
import { useAppSettingsLoader } from './hooks/use-app-settings'
import { useKeyboardShortcutsLoader } from './hooks/use-keyboard-shortcuts'
import { useProjectsLoader, useProjectsAutoSave } from './hooks/use-projects-persistence'
import { useMenuUpdaterListener } from './hooks/use-menu-updater-listener'
import { useUpdateCheck } from './hooks/use-updater'
import { useUpdateToast } from './components/UpdateAvailableToast'
import { useVisibilityState } from './hooks/use-visibility-state'

const queryClient = new QueryClient()

// Component to handle app-level effects like auto-save
function AppEffects(): null {
  useTerminalAutoSave()
  useTerminalRestore()
  useTerminalDetachedOutput()
  useCwd()
  useGitBranch()
  useGitStatus()
  useExitCode()
  useContextBarSettings()
  useAppSettingsLoader()
  useKeyboardShortcutsLoader()
  useProjectsLoader()
  useProjectsAutoSave()
  useMenuUpdaterListener()
  useUpdateCheck()
  useUpdateToast()
  useVisibilityState()
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
        <AppEffects />
        <Toaster />
        <Sonner />
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
