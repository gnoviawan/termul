import { type MutableRefObject, useCallback, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, FileEdit, Save, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconSwap } from '@/components/ui/icon-swap'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { useCodeMirror } from '@/hooks/use-codemirror'
import { sshApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { detectLanguage } from '@/stores/editor-store'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import {
  useSSHActions,
  useSSHEditorContent,
  useSSHEditorFile,
  useSSHStore
} from '@/stores/ssh-store'

interface SSHFileEditorProps {
  connectionId: string
}

const ignore = (): void => {}

interface RemoteCodeViewProps {
  path: string
  name: string
  content: string
  onChange: (content: string) => void
  onSave: (content: string) => void
  flushRef: MutableRefObject<(() => void) | null>
}

/** The shared code editor (line numbers, syntax, theme) for one remote file. */
function RemoteCodeView({
  path,
  name,
  content,
  onChange,
  onSave,
  flushRef
}: RemoteCodeViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const { view, flushPendingContent } = useCodeMirror(containerRef, {
    filePath: path,
    content,
    language: detectLanguage(name),
    // The unmount flush of a replaced file must not land on the next one.
    onChange: (text) => {
      if (useSSHStore.getState().editingFile?.path === path) onChange(text)
    },
    onCursorChange: ignore,
    onScrollChange: ignore,
    onSave
  })

  useEffect(() => {
    flushRef.current = flushPendingContent
    return () => {
      flushRef.current = null
    }
  }, [flushRef, flushPendingContent])

  useEffect(() => {
    view?.contentDOM.setAttribute('aria-label', `Contents of ${path}`)
  }, [view, path])

  return <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
}

export function SSHFileEditor({ connectionId }: SSHFileEditorProps): React.JSX.Element {
  const { setEditingFile: setStoreFile, setEditingContent: setStoreContent } = useSSHActions()
  const editingFile = useSSHEditorFile()
  const editingContent = useSSHEditorContent()
  const [isSaving, setIsSaving] = useState(false)
  const [saveAnimating, setSaveAnimating] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const flushRef = useRef<(() => void) | null>(null)

  const isDirty = editingFile !== null && editingContent !== editingFile.originalContent

  /** `latest` is the editor text (Mod-s); without it, flush the debounced edit. */
  const handleSave = useCallback(
    async (latest?: string) => {
      if (!editingFile || !connectionId) return
      if (latest === undefined) flushRef.current?.()
      else setStoreContent(latest)
      const content = latest ?? useSSHStore.getState().editingContent
      setIsSaving(true)
      setSaveAnimating(true)
      try {
        const result = await sshApi.sftpWriteFile(connectionId, editingFile.path, content)
        if (result.success) {
          // Another file may have been opened while the write was in flight;
          // only the file that was written becomes "saved".
          const current = useSSHStore.getState().editingFile
          if (
            current &&
            current.path === editingFile.path &&
            current.connectionId === editingFile.connectionId
          ) {
            setStoreFile({ ...current, originalContent: content })
          }
          setConfirmClose(false)
          toast.success(`Saved ${editingFile.name}`)
          setTimeout(() => setSaveAnimating(false), 600)
        } else {
          toast.error(`Save failed: ${result.error}`)
          setSaveAnimating(false)
        }
      } catch (error) {
        toast.error(`Save failed: ${error instanceof Error ? error.message : String(error)}`)
        setSaveAnimating(false)
      } finally {
        setIsSaving(false)
      }
    },
    [editingFile, connectionId, setStoreFile, setStoreContent]
  )

  const handleClose = useCallback(() => {
    if (isDirty) setConfirmClose(true)
    else setStoreFile(null)
  }, [isDirty, setStoreFile])

  // Only the unsaved-changes confirm is an overlay (the editor body is not).
  // Mobile web shell: system back takes the safe choice, "Keep editing",
  // so nothing is saved or discarded (inert on desktop).
  const confirmOverlayId = `ssh-unsaved-changes-confirm:${useId()}`
  useOverlayRegistration(
    confirmOverlayId,
    confirmClose && editingFile !== null,
    () => setConfirmClose(false),
    { mobileShellOnly: true }
  )

  if (!editingFile) return <></>

  return (
    <>
      <div className="flex h-full flex-1 flex-col">
        <div className="flex h-8 items-center justify-between border-b border-border bg-card pl-3 pr-1.5">
          <div className="flex items-center gap-2">
            <FileEdit className="h-3 w-3 text-muted-foreground" />
            <span className="text-2xs font-mono text-muted-foreground">{editingFile.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isSaving}
              aria-label={
                isDirty ? `Save ${editingFile.name} (unsaved changes)` : `Save ${editingFile.name}`
              }
              className={cn(
                'flex size-6 items-center justify-center rounded-md transition-colors duration-150 ease-out',
                FOCUS_RING_CLASS,
                saveAnimating
                  ? 'bg-success/10 text-success'
                  : isDirty
                    ? 'bg-warning/10 text-warning'
                    : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
              )}
              title="Save"
            >
              <IconSwap iconKey={saveAnimating ? 'saved' : 'save'} className="size-3">
                {saveAnimating ? <Check className="h-3 w-3" /> : <Save className="h-3 w-3" />}
              </IconSwap>
            </button>
            <button
              type="button"
              onClick={handleClose}
              className={cn(
                'flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.06] hover:text-foreground',
                FOCUS_RING_CLASS
              )}
              title="Close"
              aria-label={`Close ${editingFile.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
        <RemoteCodeView
          key={editingFile.path}
          path={editingFile.path}
          name={editingFile.name}
          content={editingContent}
          onChange={setStoreContent}
          onSave={(content) => void handleSave(content)}
          flushRef={flushRef}
        />
      </div>

      {confirmClose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/40">
          <div className="bg-background border border-border rounded-lg shadow-lg w-[340px] p-4">
            <h3 className="text-sm font-semibold mb-2">Unsaved changes</h3>
            <p className="text-xs text-muted-foreground mb-4">
              &ldquo;{editingFile.name}&rdquo; has unsaved changes.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmClose(false)}
              >
                Keep editing
              </Button>
              <Button type="button" size="sm" onClick={() => void handleSave()} disabled={isSaving}>
                Save
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  setStoreFile(null)
                  setConfirmClose(false)
                }}
              >
                Discard
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
