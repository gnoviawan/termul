import { useEffect } from 'react'
import { Toaster } from '@/components/ui/toaster'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createHashRouter, RouterProvider } from 'react-router-dom'
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

// PRODUCTION GUARDRAIL: The current xterm 6.0 migration branch is explicitly
// excluded from production rollout. Phase 1 stabilization targets xterm 5.5.
// Any future renderer upgrade must start from a fresh xterm 6.1 validation track
// and meet ADR-defined benchmark and adoption criteria before replacing the 5.5
// baseline. See _bmad-output/planning-artifacts/epics.md for the roadmap.

import { useKeyboardShortcutsLoader } from './hooks/use-keyboard-shortcuts'
import { useProjectsLoader, useProjectsAutoSave } from './hooks/use-projects-persistence'
import { useMenuUpdaterListener } from './hooks/use-menu-updater-listener'
import { useUpdateCheck } from './hooks/use-updater'
import { useUpdateToast } from './components/UpdateAvailableToast'
import { useVisibilityState } from './hooks/use-visibility-state'

// Hook to prevent Alt key from showing the default browser menu bar
function usePreventAltMenu(): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('keyup', handleKeyUp, { capture: true })

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('keyup', handleKeyUp, { capture: true })
    }
  }, [])
}

const queryClient = new QueryClient()

// Component to handle app-level effects like auto-save
function AppEffects(): null {
  usePreventAltMenu()
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

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AppEffects />
      <Toaster />
      <Sonner />
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </TooltipProvider>
  </QueryClientProvider>
)

export default App
