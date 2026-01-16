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
import { AITemplatesSettings } from './src/features/ai-templates'
import { useTerminalAutoSave } from './hooks/useTerminalAutoSave'
import { useTerminalRestore } from './hooks/use-terminal-restore'
import { useCwd } from './hooks/use-cwd'
import { useGitBranch } from './hooks/use-git-branch'
import { useGitStatus } from './hooks/use-git-status'
import { useExitCode } from './hooks/use-exit-code'
import { useContextBarSettings } from './hooks/use-context-bar-settings'
import { useAppSettingsLoader } from './hooks/use-app-settings'
import { useKeyboardShortcutsLoader } from './hooks/use-keyboard-shortcuts'
import { useProjectsLoader, useProjectsAutoSave } from './hooks/use-projects-persistence'
import { useMenuUpdaterListener } from './hooks/use-menu-updater-listener'

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
        { path: 'preferences', element: <AppPreferences /> },
        { path: 'ai-templates', element: <AITemplatesSettings /> }
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
