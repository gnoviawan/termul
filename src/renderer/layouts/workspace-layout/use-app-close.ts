import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { flushSessionHistory, waitForPendingSessionIndexWrite } from '@/lib/acp-history-persistence'
import { persistenceApi, windowApi } from '@/lib/api'
import { unmountCanvases } from '@/lib/canvas-unmount-flow'
import { runCloseWriters } from '@/lib/close-flush'
import { listen, type UnlistenFn } from '@/lib/tauri-event'
import { useEditorStore } from '@/stores/editor-store'

/** App-close interception: unsaved-files dialog state, canvas unmount,
 * persistence flush, tray quit. */
export function useAppClose() {
  const [isAppCloseDialogOpen, setIsAppCloseDialogOpen] = useState(false)
  const [appCloseDirtyCount, setAppCloseDirtyCount] = useState(0)

  const closeAppWithPersistenceFlush = useCallback(async () => {
    // Canvases save through their editors before anything shuts down (AD-31);
    // a canvas the user keeps editing cancels the quit.
    setIsAppCloseDialogOpen(false)
    if (!(await unmountCanvases())) {
      windowApi.respondToClose('cancel')
      return
    }
    try {
      const [pendingPersistenceResult, pendingSessionIndexResult, historyFlushResult] =
        await Promise.allSettled([
          persistenceApi.flushPendingWrites(),
          waitForPendingSessionIndexWrite(),
          flushSessionHistory(),
          runCloseWriters()
        ])

      // Note: waitForPendingSessionIndexWrite swallows rejections internally
      // (trackPendingIndexWrite catches and logs them), so this branch is
      // effectively dead code — kept as a defensive guard in case the
      // swallowing behavior changes.
      if (pendingSessionIndexResult.status === 'rejected') {
        console.error(
          'Failed to wait for session index persistence before close:',
          pendingSessionIndexResult.reason
        )
      }

      if (historyFlushResult.status === 'rejected') {
        console.error('Failed to flush ACP history before close:', historyFlushResult.reason)
      }

      if (pendingPersistenceResult.status === 'fulfilled') {
        if (!pendingPersistenceResult.value.success) {
          console.error(
            'Failed to flush pending persistence writes before close:',
            pendingPersistenceResult.value.error
          )
        }
      } else {
        console.error(
          'Failed to flush pending persistence writes before close:',
          pendingPersistenceResult.reason
        )
      }
    } finally {
      windowApi.respondToClose('close')
      setIsAppCloseDialogOpen(false)
    }
  }, [])

  // Intercept app close to check for unsaved files
  useEffect(() => {
    return windowApi.onCloseRequested(() => {
      const dirtyCount = useEditorStore.getState().getDirtyFileCount()
      if (dirtyCount > 0) {
        setAppCloseDirtyCount(dirtyCount)
        setIsAppCloseDialogOpen(true)
      } else {
        void closeAppWithPersistenceFlush()
      }

      return Promise.resolve(false)
    })
  }, [closeAppWithPersistenceFlush])

  // Tray Quit is an explicit app-quit request. It reuses the renderer's
  // existing dirty-file prompt and persistence flush instead of bypassing it
  // with a native app.exit(0).
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let disposed = false
    listen<void>('tray:quit-requested', () => {
      const dirtyCount = useEditorStore.getState().getDirtyFileCount()
      if (dirtyCount > 0) {
        setAppCloseDirtyCount(dirtyCount)
        setIsAppCloseDialogOpen(true)
      } else {
        void closeAppWithPersistenceFlush()
      }
    })
      .then((fn) => {
        if (disposed) {
          fn()
        } else {
          unlisten = fn
        }
      })
      .catch((error) => {
        console.error('Failed to register tray quit listener:', error)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [closeAppWithPersistenceFlush])

  // App close dialog handlers
  const handleSaveAllAndClose = useCallback(async () => {
    await useEditorStore.getState().saveAllDirty()
    const remaining = useEditorStore.getState().getDirtyFileCount()
    if (remaining > 0) {
      toast.error('Some files failed to save. Please try again or discard changes.')
      return
    }
    await closeAppWithPersistenceFlush()
  }, [closeAppWithPersistenceFlush])

  const handleDiscardAllAndClose = useCallback(() => {
    void closeAppWithPersistenceFlush()
  }, [closeAppWithPersistenceFlush])

  const handleCancelAppClose = useCallback(() => {
    windowApi.respondToClose('cancel')
    setIsAppCloseDialogOpen(false)
  }, [])

  return {
    isAppCloseDialogOpen,
    appCloseDirtyCount,
    handleSaveAllAndClose,
    handleDiscardAllAndClose,
    handleCancelAppClose
  }
}
