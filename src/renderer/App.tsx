import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { Toaster } from '@/components/ui/toaster'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppSettingsLoader } from './hooks/use-app-settings'
import { useAppliedColorThemeSync } from './hooks/use-color-theme'
import { useContextBarSettings } from './hooks/use-context-bar-settings'
import { useCwd } from './hooks/use-cwd'
import { useExitCode } from './hooks/use-exit-code'
import { useGitBranch } from './hooks/use-git-branch'
import { useGitStatus } from './hooks/use-git-status'
import { useTerminalDetachedOutput } from './hooks/use-terminal-detached-output'
import { useTerminalRestore } from './hooks/use-terminal-restore'
import { useTerminalAutoSave } from './hooks/useTerminalAutoSave'
import WorkspaceLayout from './layouts/WorkspaceLayout'
import AppPreferences from './pages/AppPreferences'
import NotFound from './pages/NotFound'
import ProjectSettings from './pages/ProjectSettings'
import WorkspaceDashboard from './pages/WorkspaceDashboard'
import WorkspaceSnapshots from './pages/WorkspaceSnapshots'

// PRODUCTION GUARDRAIL: This branch targets xterm 6.1-beta (the line VS Code
// ships in production). The 6.1 beta track includes memory leak fixes
// (IntersectionObserver retention, dispose-registration gaps) and TUI stability
// (alt-buffer teleport fix, currentRow OOM fix) not present in 6.0 stable.
// WebGL is preserved as the GPU renderer with DOM fallback ("canvas" removed in 6.0).
// See _bmad-output/implementation-artifacts/spec-gh133-xterm-6-1-upgrade-memory-leak-fix.md.

import { isWindows } from '@/lib/platform'
import { useUpdateToast } from './components/UpdateAvailableToast'
import { useAcpAgents } from './hooks/use-acp-agents'
import { useAcpHistory } from './hooks/use-acp-history'
import { useAcpListeners } from './hooks/use-acp-listeners'
import { useAcpMcp } from './hooks/use-acp-mcp'
import { useKeyboardShortcutsLoader } from './hooks/use-keyboard-shortcuts'
import { useMenuUpdaterListener } from './hooks/use-menu-updater-listener'
import { useProjectsAutoSave, useProjectsLoader } from './hooks/use-projects-persistence'
import { useUpdateCheck } from './hooks/use-updater'
import { useVisibilityState } from './hooks/use-visibility-state'

// Hook to prevent Alt key from showing the default browser menu bar.
// Only needed on Windows — on macOS, Alt/Option is used for typing special characters.
function usePreventAltMenu(): void {
  useEffect(() => {
    // Skip on macOS — Alt/Option is needed for typing special chars (@, €, £, etc.)
    if (!isWindows) return

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

// TODO(renderer-upgrade-adrs / ADR-xterm-renderer-upgrade): enforce the xterm 6.1
// production baseline and ensure the DOM renderer fallback path works correctly.
// A build/CI/runtime gate (e.g. checkRendererVersion helper) should verify the
// installed @xterm/xterm version is on the expected 6.1 line.
// initialization or a check-renderer-whitelist CI job). Do not rely on comments alone.

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
  useAppliedColorThemeSync()
  useKeyboardShortcutsLoader()
  useProjectsLoader()
  useProjectsAutoSave()
  useMenuUpdaterListener()
  useAcpListeners()
  useAcpAgents()
  useAcpHistory()
  useAcpMcp()
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
