import { FileEdit, Save, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useSshTranslation } from '@/hooks/use-ssh-translation'
import { sshApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSSHActions, useSSHEditorContent, useSSHEditorFile } from '@/stores/ssh-store'

interface SSHFileEditorProps {
  connectionId: string
}

export function SSHFileEditor({ connectionId }: SSHFileEditorProps): React.JSX.Element {
  const t = useSshTranslation()
  const { setEditingFile: setStoreFile, setEditingContent: setStoreContent } = useSSHActions()
  const editingFile = useSSHEditorFile()
  const editingContent = useSSHEditorContent()
  const [isSaving, setIsSaving] = useState(false)
  const [saveAnimating, setSaveAnimating] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const isDirty = editingFile !== null && editingContent !== editingFile.originalContent

  const handleSave = useCallback(async () => {
    if (!editingFile || !connectionId) return
    setIsSaving(true)
    setSaveAnimating(true)
    try {
      const result = await sshApi.sftpWriteFile(connectionId, editingFile.path, editingContent)
      if (result.success) {
        setStoreFile({ ...editingFile, originalContent: editingContent })
        setConfirmClose(false)
        toast.success(t('fileEditor.saved', { name: editingFile.name }))
        setTimeout(() => setSaveAnimating(false), 600)
      } else {
        toast.error(t('fileEditor.saveFailed', { error: result.error }))
        setSaveAnimating(false)
      }
    } catch (error) {
      toast.error(
        t('fileEditor.saveFailed', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
      setSaveAnimating(false)
    } finally {
      setIsSaving(false)
    }
  }, [editingFile, connectionId, editingContent, setStoreFile, t])

  const handleClose = useCallback(() => {
    if (isDirty) setConfirmClose(true)
    else setStoreFile(null)
  }, [isDirty, setStoreFile])

  if (!editingFile) return <></>

  return (
    <>
      <div className="flex-1 flex flex-col">
        <div className="h-8 flex items-center justify-between px-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <FileEdit className="h-3 w-3 text-muted-foreground" />
            <span className="text-2xs font-mono text-muted-foreground">{editingFile.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className={cn(
                'p-1 rounded transition-all duration-300',
                saveAnimating
                  ? 'bg-green-500/20 text-green-500 scale-110'
                  : isDirty
                    ? 'bg-amber-500/20 text-amber-500'
                    : 'hover:bg-accent text-muted-foreground'
              )}
              title={t('actions.save')}
            >
              <Save className={cn('h-3 w-3', saveAnimating && 'animate-pulse')} />
            </button>
            <button
              onClick={handleClose}
              className="p-1 rounded hover:bg-accent text-muted-foreground"
              title={t('actions.close')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
        <textarea
          value={editingContent}
          onChange={(e) => setStoreContent(e.target.value)}
          className="flex-1 w-full p-3 text-xs font-mono bg-background resize-none focus:outline-none"
          spellCheck={false}
        />
      </div>

      {confirmClose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background border border-border rounded-lg shadow-lg w-[340px] p-4">
            <h3 className="text-sm font-semibold mb-2">{t('fileEditor.unsavedTitle')}</h3>
            <p className="text-xs text-muted-foreground mb-4">
              {t('fileEditor.unsavedMessage', { name: editingFile.name })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmClose(false)}
                className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent"
              >
                {t('fileEditor.continueEditing')}
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {t('actions.save')}
              </button>
              <button
                onClick={() => {
                  setStoreFile(null)
                  setConfirmClose(false)
                }}
                className="px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t('actions.discard')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
