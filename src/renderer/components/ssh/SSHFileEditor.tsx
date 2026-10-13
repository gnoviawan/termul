import { type MutableRefObject, useCallback, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FileEdit, Save, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
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
  onSave: () => void
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

  const handleSave = useCallback(async () => {
    if (!editingFile || !connectionId) return
    // The code view reports edits after a short debounce; take the latest text.
    flushRef.current?.()
    const content = useSSHStore.getState().editingContent
    setIsSaving(true)
    setSaveAnimating(true)
    try {
      const result = await sshApi.sftpWriteFile(connectionId, editingFile.path, content)
      if (result.success) {
        setStoreFile({ ...editingFile, originalContent: content })
        setConfirmClose(false)
        toast.success(`Saved: ${editingFile.name}`)
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
  }, [editingFile, connectionId, setStoreFile])

  const handleClose = useCallback(() => {
    if (isDirty) setConfirmClose(true)
    else setStoreFile(null)
  }, [isDirty, setStoreFile])

  // Only the unsaved-changes confirm is an overlay (the editor body is not).
  // Mobile web shell: system back takes the safe choice, "Continue Editing",
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
        <div className="h-8 flex items-center justify-between px-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <FileEdit className="h-3 w-3 text-muted-foreground" />
            <span className="text-2xs font-mono text-muted-foreground">{editingFile.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              aria-label={
                isDirty ? `Save ${editingFile.name} (unsaved changes)` : `Save ${editingFile.name}`
              }
              className={cn(
                'p-1 rounded transition-all duration-300',
                saveAnimating
                  ? 'bg-success/20 text-success scale-110'
                  : isDirty
                    ? 'bg-warning/20 text-warning'
                    : 'hover:bg-accent text-muted-foreground'
              )}
              title="Save"
            >
              <Save className={cn('h-3 w-3', saveAnimating && 'animate-pulse')} />
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="p-1 rounded hover:bg-accent text-muted-foreground"
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
          onSave={() => void handleSave()}
          flushRef={flushRef}
        />
      </div>

      {confirmClose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/40">
          <div className="bg-background border border-border rounded-lg shadow-lg w-[340px] p-4">
            <h3 className="text-sm font-semibold mb-2">Unsaved Changes</h3>
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
                Continue Editing
              </Button>
              <Button type="button" size="sm" onClick={handleSave} disabled={isSaving}>
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
