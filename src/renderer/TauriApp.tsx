import { useEffect, useRef, useState } from 'react'
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
import { RemoteAccessPanel } from '@/components/remote/RemoteAccessPanel'
import { useTerminalAutoSave } from './hooks/useTerminalAutoSave'
import { useTerminalRestore } from './hooks/use-terminal-restore'
import { useCrashRecovery } from './hooks/use-crash-recovery'
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
import { useTerminalExitNotification } from './hooks/use-terminal-exit-notification'
import { initNotificationPermissions } from './lib/tauri-notification-api'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { wsServerApi } from '@/lib/ws-server-api'
import { listen } from '@tauri-apps/api/event'

const queryClient = new QueryClient()

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
  useKeyboardShortcutsLoader()
  useProjectsLoader()
  useProjectsAutoSave()
  useMenuUpdaterListener()
  useUpdateCheck()
  useUpdateToast()
  useVisibilityState()
  useTerminalExitNotification()

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
        { path: 'preferences', element: <AppPreferences /> },
        { path: 'remote', element: <RemoteAccessPanel /> }
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
  const [isLocked, setIsLocked] = useState(false)
  const isLockedRef = useRef(false)

  useEffect(() => {
    isLockedRef.current = isLocked
  }, [isLocked])

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

  useEffect(() => {
    const handlePointerDown = (): void => {
      // Don't send handover while desktop is locked — the overlay button click
      // would otherwise immediately re-lock the web side.
      if (isLockedRef.current) return
      console.log('[TauriApp] pointerdown -> handover web')
      void wsServerApi.lockHandover('web')
    }

    const unlistenPromise = listen('ui-lock-handover', ({ payload }) => {
      console.log('[TauriApp] ui-lock-handover', payload)
      if ((payload as { target?: string } | undefined)?.target === 'desktop') {
        console.log('[TauriApp] locked desktop')
        setIsLocked(true)
      }
    })

    console.log('[TauriApp] pointerdown listener attached')
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary context="App Root">
          <AppEffects />
          <Toaster />
          <Sonner />
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
          {isLocked && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md">
              <div className="w-full max-w-md rounded-3xl border border-zinc-800 bg-zinc-950/95 p-8 text-center shadow-2xl">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-500/20 bg-blue-500/10 text-2xl">🔒</div>
                <h2 className="text-xl font-semibold text-white">Desktop Locked</h2>
                <p className="mt-2 text-sm text-zinc-400">Click anywhere on desktop to lock Web Lite. Click Open to reload.</p>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsLocked(false)
                  }}
                  className="mt-6 w-full rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-500"
                >
                  Open Desktop
                </button>
              </div>
            </div>
          )}
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
