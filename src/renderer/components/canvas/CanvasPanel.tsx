/**
 * Canvas panel (OpenPencil canvas mode) — the `canvas` tab's PaneContent
 * dispatch target. Owns the panel chrome (status, save, conflict
 * `ConfirmDialog`) and the bridge wiring: creates the bridge when the iframe
 * mounts (or re-navigates — a fresh embed URL means a token rotation or a
 * doc re-bind), forwards bridge events into the canvas-store, runs the save
 * flow (`op-shell/save` + the Save button → store saveCanvas → facade save
 * through the daemon, then the bridge's `save-committed` ack), and pushes
 * theme (`useAppearanceMode`) + locale (`navigator.language`) into the
 * embedded editor on mount and on change (CAP-4).
 */

import { useCallback, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Edit2, Loader2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { clipboardApi } from '@/lib/api'
import {
  type CanvasBridgeController,
  createCanvasBridge,
  DESKTOP_BRIDGE_INIT_TOKEN,
  originOfEmbedUrl,
  toSupportedBridgeLocale
} from '@/lib/canvas-bridge'
import { useAppearanceMode } from '@/stores/app-settings-store'
import { type CanvasSession, useCanvasStore } from '@/stores/canvas-store'
import { CanvasShell } from './CanvasShell'

interface CanvasPanelProps {
  projectId: string
  docPath: string
  isVisible: boolean
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function statusLabel(session: CanvasSession): string {
  if (session.status === 'error') return 'Canvas failed to connect'
  if (session.status === 'opening') return 'Starting canvas…'
  if (!session.bridgeReady) return 'Connecting…'
  return 'Ready'
}

export function CanvasPanel({
  projectId,
  docPath,
  isVisible
}: CanvasPanelProps): React.JSX.Element {
  const session = useCanvasStore((state) => state.sessions[projectId] ?? null)
  const { saveCanvas, resolveConflict, dismissConflict } = useCanvasStore(
    useShallow((state) => ({
      saveCanvas: state.saveCanvas,
      resolveConflict: state.resolveConflict,
      dismissConflict: state.dismissConflict
    }))
  )
  const appearanceMode = useAppearanceMode()

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<CanvasBridgeController | null>(null)

  const embedUrl = session?.embedUrl ?? ''

  // Bridge lifecycle: keyed to the embed URL — a fresh URL means a new
  // editor page (token rotation / doc re-bind), so the old bridge is torn
  // down and a new one attaches with the fresh init token + mcpUrl. The
  // session is read via getState() inside the effect so dirty/revision churn
  // never recreates the bridge.
  useEffect(() => {
    if (!embedUrl) return
    const iframe = iframeRef.current
    if (!iframe) return
    const current = useCanvasStore.getState().sessions[projectId]
    if (!current) return
    const bridge = createCanvasBridge({
      iframe,
      iframeOrigin: originOfEmbedUrl(embedUrl),
      token: current.bridgeToken ?? DESKTOP_BRIDGE_INIT_TOKEN,
      mcpUrl: current.mcpUrl,
      onEvent: (event) => {
        useCanvasStore.getState().handleBridgeEvent(projectId, event)
      },
      onShellSave: () => {
        void useCanvasStore.getState().saveCanvas(projectId)
      },
      onShellCopy: (text) => {
        void clipboardApi.writeText(text)
      },
      onInitFailed: () => {
        useCanvasStore.getState().handleInitFailed(projectId)
      }
    })
    bridgeRef.current = bridge
    useCanvasStore.getState().attachBridge(projectId, bridge)
    return () => {
      bridgeRef.current = null
      useCanvasStore.getState().detachBridge(projectId, bridge)
    }
  }, [embedUrl, projectId])

  // Theme push (CAP-4): current appearance mode on mount + on change (and
  // re-pushed whenever a fresh bridge attaches / reaches ready).
  // biome-ignore lint/correctness/useExhaustiveDependencies: embedUrl + bridgeReady intentionally re-fire the push when a fresh bridge attaches (token rotation / doc re-bind); the pushed value is appearanceMode
  useEffect(() => {
    useCanvasStore.getState().pushTheme(projectId, appearanceMode)
  }, [projectId, appearanceMode, embedUrl, session?.bridgeReady])

  // Locale push: no i18n system exists — push the host locale on mount (and
  // on re-bind), mapped to a value the editor's codec accepts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: embedUrl intentionally re-fires the push when a fresh bridge attaches (doc re-bind)
  useEffect(() => {
    const locale =
      typeof navigator !== 'undefined' && navigator.language
        ? toSupportedBridgeLocale(navigator.language)
        : 'en-US'
    useCanvasStore.getState().pushLocale(projectId, locale)
  }, [projectId, embedUrl])

  const handleSave = useCallback(() => {
    void saveCanvas(projectId)
  }, [saveCanvas, projectId])

  const handleResolve = useCallback(
    (mode: 'use-local' | 'accept-remote') => {
      resolveConflict(projectId, mode)
    },
    [resolveConflict, projectId]
  )

  if (!session) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <span className="text-sm text-muted-foreground">Canvas closed</span>
      </div>
    )
  }

  return (
    <div
      className="flex h-full w-full flex-col bg-background"
      data-canvas-tab-state={isVisible ? 'visible' : 'hidden'}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Edit2 size={12} className="shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 truncate text-2xs font-medium text-foreground">
          {basename(session.docPath || docPath)}
        </span>
        {session.dirty && (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-primary-fill"
            aria-label="Unsaved changes"
            title="Unsaved changes"
          />
        )}
        <span className="shrink-0 text-3xs text-muted-foreground">{statusLabel(session)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="secondary"
            disabled={!session.bridgeReady || session.saving}
            onClick={handleSave}
            aria-label="Save canvas"
          >
            {session.saving ? (
              <Loader2
                size={12}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            Save
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {session.status === 'opening' || !embedUrl ? (
          <div className="flex h-full w-full items-center justify-center">
            <span className="text-sm text-muted-foreground">Starting canvas…</span>
          </div>
        ) : (
          <CanvasShell
            key={embedUrl}
            embedUrl={embedUrl}
            title={`OpenPencil canvas — ${basename(session.docPath || docPath)}`}
            iframeRef={iframeRef}
          />
        )}
      </div>
      <ConfirmDialog
        isOpen={session.conflict !== null}
        title="Canvas conflict"
        message="The document changed while you were editing. Choose which version to keep."
        variant="danger"
        confirmLabel="Keep my changes"
        cancelLabel="Dismiss"
        secondaryAction={{
          label: 'Use the saved version',
          onClick: () => handleResolve('accept-remote')
        }}
        onConfirm={() => handleResolve('use-local')}
        onCancel={() => dismissConflict(projectId)}
      />
    </div>
  )
}
