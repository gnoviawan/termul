/**
 * Draft-vs-disk conflict banner (Story 10). Shown above the editor when a
 * restored unsaved draft differs from a file that changed on disk after the
 * draft was saved. The user keeps the draft (becomes an unsaved edit) or the
 * disk version; nothing is dropped silently.
 */

import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { useEditorStore } from '@/stores/editor-store'

interface EditorDraftConflictBannerProps {
  filePath: string
}

export function EditorDraftConflictBanner({
  filePath
}: EditorDraftConflictBannerProps): null | React.ReactElement {
  const hasConflict = useEditorStore((state) => {
    const file = state.openFiles.get(filePath)
    return file?.kind === 'text' && file.draftConflict !== undefined
  })

  const handleKeepDraft = useCallback(() => {
    useEditorStore.getState().resolveDraftConflict(filePath, 'draft')
  }, [filePath])

  const handleUseDisk = useCallback(() => {
    useEditorStore.getState().resolveDraftConflict(filePath, 'disk')
  }, [filePath])

  if (!hasConflict) return null

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col gap-2 border-b border-warning/50 bg-warning/10 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="text-xs text-warning">
        An unsaved draft differs from the newer file on disk.
      </span>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button type="button" variant="default" size="xs" onClick={handleKeepDraft}>
          Keep my draft
        </Button>
        <Button type="button" variant="secondary" size="xs" onClick={handleUseDisk}>
          Use disk version
        </Button>
      </div>
    </div>
  )
}
