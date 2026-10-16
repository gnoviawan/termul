import { useCallback, useRef } from 'react'

interface UseComposerDraftStartArgs {
  /** The draft has no text and no attachments (as of this render). */
  draftEmpty: boolean
  /** Fired on the first edit or paste into an empty draft. */
  onDraftStart?: () => void
  setValue: (next: string) => void
  handlePaste: (event: ClipboardEvent) => void
}

/**
 * Draft-start signal for the chat composer. The editor only emits
 * `onValueChange` for user edits (its external sync is silent), so a restored
 * draft or a seed never fires `onDraftStart`. The emptiness ref flips on the
 * first fire, so a paste that also inserts text signals once.
 */
export function useComposerDraftStart({
  draftEmpty,
  onDraftStart,
  setValue,
  handlePaste
}: UseComposerDraftStartArgs): {
  handleValueChange: (next: string) => void
  handleComposerPaste: (event: ClipboardEvent) => void
} {
  const draftEmptyRef = useRef(draftEmpty)
  draftEmptyRef.current = draftEmpty
  const onDraftStartRef = useRef(onDraftStart)
  onDraftStartRef.current = onDraftStart
  const signalDraftStart = useCallback(() => {
    if (!draftEmptyRef.current) return
    draftEmptyRef.current = false
    onDraftStartRef.current?.()
  }, [])
  const handleValueChange = useCallback(
    (next: string) => {
      if (next.length > 0) signalDraftStart()
      setValue(next)
    },
    [setValue, signalDraftStart]
  )
  const handleComposerPaste = useCallback(
    (event: ClipboardEvent) => {
      signalDraftStart()
      handlePaste(event)
    },
    [handlePaste, signalDraftStart]
  )
  return { handleValueChange, handleComposerPaste }
}
