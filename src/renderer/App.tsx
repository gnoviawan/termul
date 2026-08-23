import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect } from 'react'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { ChatRoute } from '@/components/ChatRoute'
import { DirectoryPicker } from '@/components/DirectoryPicker'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { GlobalContextMenu } from '@/components/GlobalContextMenu'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { Toaster } from '@/components/ui/toaster'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WhatsNewModal } from './components/WhatsNewModal'
import { useAppSettingsLoader } from './hooks/use-app-settings'
import { useAppliedColorThemeSync } from './hooks/use-color-theme'
import { useContextBarSettings } from './hooks/use-context-bar-settings'
import { useCrashRecovery } from './hooks/use-crash-recovery'
import { useCwd } from './hooks/use-cwd'
import { useExitCode } from './hooks/use-exit-code'
import { useGitBranch } from './hooks/use-git-branch'
import { useGitStatus } from './hooks/use-git-status'
import { useProjectGitBranch } from './hooks/use-project-git-branch'
import { useRemoteProjects } from './hooks/use-remote-projects'
import { useTerminalDetachedOutput } from './hooks/use-terminal-detached-output'
import { useTerminalExitNotification } from './hooks/use-terminal-exit-notification'
import { useTerminalRestore } from './hooks/use-terminal-restore'
import { useWhatsNew } from './hooks/use-whats-new'
import { useTerminalAutoSave } from './hooks/useTerminalAutoSave'
import WorkspaceLayout from './layouts/WorkspaceLayout'
import { initNotificationPermissions } from './lib/tauri-notification-api'

const WorkspaceDashboard = lazy(() => import('./pages/WorkspaceDashboard'))
const ProjectSettings = lazy(() => import('./pages/ProjectSettings'))
const AppPreferences = lazy(() => import('./pages/AppPreferences'))
const WorkspaceSnapshots = lazy(() => import('./pages/WorkspaceSnapshots'))
const NotFound = lazy(() => import('./pages/NotFound'))

function RouteFallback(): React.JSX.Element {
  return <Skeleton className="h-full w-full" />
}

// PRODUCTION GUARDRAIL: This branch targets xterm 6.1-beta (the line VS Code
// ships in production). The 6.1 beta track includes memory leak fixes
// (IntersectionObserver retention, dispose-registration gaps) and TUI stability
// (alt-buffer teleport fix, currentRow OOM fix) not present in 6.0 stable.
// WebGL is preserved as the GPU renderer with DOM fallback ("canvas" removed in 6.0).
// See _bmad-output/implementation-artifacts/spec-gh133-xterm-6-1-upgrade-memory-leak-fix.md.

import { isWindows } from '@/lib/platform'
import { isTauriContext, primeServerCapability } from '@/lib/tauri-runtime'
import { useUpdateToast } from './components/UpdateAvailableToast'
import { useAcpAgents } from './hooks/use-acp-agents'
import { useAcpHistory } from './hooks/use-acp-history'
import { useAcpListeners } from './hooks/use-acp-listeners'
import { useAcpMcp } from './hooks/use-acp-mcp'
import { useAcpSessionResume } from './hooks/use-acp-session-resume'
import { useKeyboardShortcutsLoader } from './hooks/use-keyboard-shortcuts'
import { useMenuUpdaterListener } from './hooks/use-menu-updater-listener'
import { usePreventFileDropNavigation } from './hooks/use-prevent-file-drop-navigation'
import { usePreventNativeContextMenu } from './hooks/use-prevent-native-context-menu'
import { useProjectsAutoSave, useProjectsLoader } from './hooks/use-projects-persistence'
import { useAppliedUiZoomSync } from './hooks/use-ui-zoom'
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

// Component to handle app-level effects like auto-save.
// Mirrors TauriApp.tsx AppEffects mount order for the portable subset.
// Native-only effects (usePreventDevToolsShortcuts, showWindow, useWindowState)
// are intentionally NOT ported — they would break the browser (web cannot
// block its own devtools; no native window). The global context menu is
// mounted on both surfaces via <GlobalContextMenu> in the root render.
// usePreventNativeContextMenu is ported for parity (portal regression defense).
// usePreventAltMenu stays (web-only).
function AppEffects(): null {
  usePreventAltMenu()
  // One-shot: prime the server write-admission capability cache from
  // `GET /health` so write-gated web surfaces (e.g. the worktree picker) reflect
  // the server's actual admission policy instead of a hostname guess. No-op on
  // desktop (`isTauriContext()` → cache seeded admitted, no fetch). Runs once
  // on web mount; a failed fetch leaves the cache fail-closed (false) and a
  // later re-prime can retry.
  useEffect(() => {
    primeServerCapability()
  }, [])

  useTerminalAutoSave()
  useTerminalRestore()
  useCrashRecovery()
  useTerminalDetachedOutput()
  useCwd()
  useGitBranch()
  useProjectGitBranch()
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
  // Suppress the native browser context menu app-wide (BUBBLE phase) for web
  // parity — portaled overlays (toasts, modals) outside
  // <GlobalContextMenu>'s Radix trigger subtree would show the browser's
  // native Inspect menu. Bubble — not capture — so the Radix trigger
  // (composeEventHandlers, defaultPrevented check) still opens the global menu.
  usePreventNativeContextMenu()

  // Initialize notification permissions once at app startup so the OS (or
  // browser) permission prompt appears early, not on first terminal exit. On
  // web this calls the Web Notifications API (`Notification.requestPermission`);
  // on desktop, the Tauri notification plugin. No-op in SSR/test (no
  // `Notification` global).
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
        {
          index: true,
          element: (
            <Suspense fallback={<RouteFallback />}>
              <WorkspaceDashboard />
            </Suspense>
          )
        },
        { path: 'c/:sessionId', element: <ChatRoute /> },
        {
          path: 'snapshots',
          element: (
            <Suspense fallback={<RouteFallback />}>
              <WorkspaceSnapshots />
            </Suspense>
          )
        },
        {
          path: 'settings',
          element: (
            <Suspense fallback={<RouteFallback />}>
              <ProjectSettings />
            </Suspense>
          )
        },
        {
          path: 'preferences',
          element: (
            <Suspense fallback={<RouteFallback />}>
              <AppPreferences />
            </Suspense>
          )
        }
      ]
    },
    {
      path: '*',
      element: (
        <Suspense fallback={<RouteFallback />}>
          <NotFound />
        </Suspense>
      )
    }
  ],
  {
    future: {
      v7_relativeSplatPath: true
    }
  }
)

const App = () => {
  const whatsNew = useWhatsNew()
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={80} skipDelayDuration={300}>
        <GlobalContextMenu>
          <ErrorBoundary context="App Root">
            <AppEffects />
            <Toaster />
            <Sonner />
            {/* Web/remote mode only: in-app directory picker registered with
                dialogApi so NewProjectModal's Browse button works without a native
                dialog.open (Story: Web/remote project creation). Desktop never
                mounts it. */}
            {!isTauriContext() && <DirectoryPicker />}
            <RouterProvider router={router} future={{ v7_startTransition: true }} />
            <WhatsNewModal
              isOpen={whatsNew.isOpen}
              version={whatsNew.version}
              notes={whatsNew.notes}
              htmlUrl={whatsNew.htmlUrl}
              onClose={whatsNew.close}
            />
          </ErrorBoundary>
        </GlobalContextMenu>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

export default App
