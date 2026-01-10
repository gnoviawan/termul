import { Toaster } from '@/components/ui/toaster'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import WorkspaceDashboard from './pages/WorkspaceDashboard'
import ProjectSettings from './pages/ProjectSettings'
import AppPreferences from './pages/AppPreferences'
import WorkspaceSnapshots from './pages/WorkspaceSnapshots'
import NotFound from './pages/NotFound'
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

const queryClient = new QueryClient()

// Component to handle app-level effects like auto-save
function AppEffects(): null {
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
  return null
}

const router = createHashRouter(
  [
    { path: '/', element: <WorkspaceDashboard /> },
    { path: '/settings', element: <ProjectSettings /> },
    { path: '/preferences', element: <AppPreferences /> },
    { path: '/snapshots', element: <WorkspaceSnapshots /> },
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
