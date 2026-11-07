/**
 * The `canvas` tab's pane: a header (doc name, unsaved marker, mount status,
 * save error, Save) over the area the figcraft iframe covers. The iframe is
 * not a child: `CanvasMountLayer` owns it so it survives this tab (AD-19),
 * and this panel only claims the slot it is laid over while visible. The
 * mount itself is driven by the canvas store's phase; this panel re-sends
 * `host.theme` / `host.locale` when Troupe's theme or the browser language
 * changes, without reloading the editor. While it shows a mounted canvas it
 * also tells the host the user is looking at it, which the mount cap ranks
 * eviction by (AD-26). A canvas the host unloaded shows a reopen prompt.
 */

import { useEffect, useState } from 'react'
import { Edit2, Loader2, Save } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { basename } from '@/lib/path-basename'
import { COLOR_THEME_CHANGED_EVENT } from '@/lib/themes'
import {
  type CanvasPhase,
  type UnloadReason,
  useCanvasSession,
  useCanvasStore
} from '@/stores/canvas-store'
import { CanvasConflictBar, CanvasCrashNotice } from './CanvasRecovery'
import { useCanvasSlots } from './canvas-slots'

interface CanvasPanelProps {
  projectId: string
  docPath: string
  isVisible: boolean
}

function statusLabel(phase: CanvasPhase, closing: boolean): string {
  if (closing) return 'Saving before close…'
  switch (phase.kind) {
    case 'opening':
      return 'Starting canvas…'
    case 'loading':
      return 'Loading editor…'
    case 'ready':
      return 'Ready'
    case 'failed':
      return 'Canvas unavailable'
    case 'elsewhere':
      return 'Open in another window'
    case 'unloaded':
      return 'Unloaded'
  }
}

/** The area the project's iframe is laid over while this panel shows. */
function CanvasSlot({
  projectId,
  mountSeq
}: {
  projectId: string
  mountSeq: number
}): React.JSX.Element {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!element) return
    const slots = useCanvasSlots.getState()
    slots.claimSlot(projectId, element)
    void useCanvasStore.getState().setCanvasVisible(projectId, mountSeq, true)
    return () => {
      useCanvasSlots.getState().releaseSlot(projectId, element)
      void useCanvasStore.getState().setCanvasVisible(projectId, mountSeq, false)
    }
  }, [projectId, mountSeq, element])
  return <div ref={setElement} className="h-full w-full" data-canvas-slot={projectId} />
}

/** AD-30: another window holds the canvas. Taking it back saves and
 * unmounts it there first; a failure is toasted and this notice stays. */
function OpenElsewhere({
  projectId,
  docPath
}: {
  projectId: string
  docPath: string
}): React.JSX.Element {
  const [taking, setTaking] = useState(false)
  const takeBack = (): void => {
    setTaking(true)
    void useCanvasStore
      .getState()
      .openCanvas(projectId, docPath)
      .finally(() => setTaking(false))
  }
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-4"
      data-testid="canvas-open-elsewhere"
    >
      <span className="text-center text-sm text-muted-foreground">
        This canvas is open in another window.
      </span>
      <Button size="xs" variant="secondary" disabled={taking} onClick={takeBack}>
        {taking && (
          <Loader2
            size={12}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        Take back
      </Button>
    </div>
  )
}

function Notice({ text, testId }: { text: string; testId?: string }): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-4">
      <span className="text-center text-sm text-muted-foreground" data-testid={testId}>
        {text}
      </span>
    </div>
  )
}

function UnloadedNotice({
  projectId,
  docPath,
  reason,
  message
}: {
  projectId: string
  docPath: string
  reason: UnloadReason
  message: string | null
}): React.JSX.Element {
  const evicted = reason === 'evicted'
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-4"
      data-testid="canvas-unloaded"
      data-canvas-unload-reason={reason}
    >
      <span className="text-center text-sm text-muted-foreground">
        {evicted
          ? 'This canvas was unloaded to save memory. Click to reopen.'
          : (message ?? 'Another canvas could not be unloaded to make room.')}
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void useCanvasStore.getState().openCanvas(projectId, docPath)}
      >
        {evicted ? 'Reopen canvas' : 'Try again'}
      </Button>
    </div>
  )
}

export function CanvasPanel({
  projectId,
  docPath,
  isVisible
}: CanvasPanelProps): React.JSX.Element {
  const session = useCanvasSession(projectId)
  const isPhoneWidth = useMobileWebShell()

  useEffect(() => {
    const pushTheme = (): void => useCanvasStore.getState().pushTheme(projectId)
    const pushLocale = (): void => useCanvasStore.getState().pushLocale(projectId)
    window.addEventListener(COLOR_THEME_CHANGED_EVENT, pushTheme)
    window.addEventListener('languagechange', pushLocale)
    return () => {
      window.removeEventListener(COLOR_THEME_CHANGED_EVENT, pushTheme)
      window.removeEventListener('languagechange', pushLocale)
    }
  }, [projectId])

  const readyMountSeq = session?.phase.kind === 'ready' ? session.phase.mount.mountSeq : null
  useEffect(() => {
    // A canvas outside the watched directories (another project's) gets no
    // watcher events: check its file whenever it is shown.
    if (isVisible && readyMountSeq !== null) void useCanvasStore.getState().checkDisk(projectId)
  }, [projectId, isVisible, readyMountSeq])

  if (isPhoneWidth) {
    return (
      <Notice
        text="The canvas is not available at this screen width."
        testId="canvas-unsupported-surface"
      />
    )
  }
  if (!session) return <Notice text="Canvas closed" />

  const name = basename(session.docPath || docPath)
  const { phase } = session
  const mount = phase.kind === 'loading' || phase.kind === 'ready' ? phase.mount : null

  return (
    <div
      className="flex h-full w-full flex-col bg-background"
      data-canvas-tab-state={isVisible ? 'visible' : 'hidden'}
      data-canvas-phase={phase.kind}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Edit2 size={12} className="shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 truncate text-2xs font-medium text-foreground">{name}</span>
        {session.dirty && (
          <span
            role="img"
            className="h-2 w-2 shrink-0 rounded-full bg-primary-fill"
            aria-label="Unsaved changes"
            title="Unsaved changes"
          />
        )}
        <span className="shrink-0 text-3xs text-muted-foreground">
          {statusLabel(phase, session.closing)}
        </span>
        {session.saveError && (
          <span
            className="min-w-0 truncate text-3xs text-destructive"
            title={session.saveError}
            data-testid="canvas-save-error"
          >
            Save failed
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="secondary"
            disabled={phase.kind !== 'ready' || session.saving}
            onClick={() => void useCanvasStore.getState().saveCanvas(projectId)}
            aria-label="Save canvas"
            title="Save canvas"
          >
            {session.saving ? (
              <Loader2
                size={12}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Save size={12} aria-hidden="true" />
            )}
            Save
          </Button>
        </div>
      </div>
      {session.conflict && (
        <CanvasConflictBar
          projectId={projectId}
          conflict={session.conflict}
          resolving={session.resolving}
        />
      )}
      {session.crash && <CanvasCrashNotice projectId={projectId} remount={session.crash} />}
      <div className="relative min-h-0 flex-1">
        {mount ? (
          isVisible && <CanvasSlot projectId={projectId} mountSeq={mount.mountSeq} />
        ) : phase.kind === 'failed' ? (
          <Notice text={phase.message} testId="canvas-mount-failed" />
        ) : phase.kind === 'elsewhere' ? (
          <OpenElsewhere projectId={projectId} docPath={session.docPath || docPath} />
        ) : phase.kind === 'unloaded' ? (
          <UnloadedNotice
            projectId={projectId}
            docPath={session.docPath || docPath}
            reason={phase.reason}
            message={phase.message}
          />
        ) : (
          <Notice text="Starting canvas…" />
        )}
      </div>
    </div>
  )
}
