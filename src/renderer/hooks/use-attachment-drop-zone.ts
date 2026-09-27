import { type DragEvent, useCallback, useRef, useState } from 'react'
import { dataTransferFiles } from '@/components/chat/use-composer-attachments'

/** Props to spread on the composer container element that owns the drop zone. */
export interface AttachmentDropZoneProps {
  onDragEnter: () => void
  onDragLeave: () => void
  onDragOver: ((event: DragEvent<HTMLDivElement>) => void) | undefined
  onDrop: (event: DragEvent<HTMLDivElement>) => void
}

/**
 * Drag feedback + drop handling for the attachment drop zone shared by the
 * Agent Chat input and the new-thread launcher (parity with ChatInputBar): a
 * depth counter tracks nested dragenter/dragleave pairs so the overlay hides
 * only when the drag fully leaves the composer. Returns the `dragActive` flag
 * — each call site renders its own overlay chrome — and the props to spread
 * on the composer container.
 */
export function useAttachmentDropZone(opts: {
  canDropPaste: boolean
  addFiles: (files: FileList | File[]) => Promise<void>
}): { dragActive: boolean; dropProps: AttachmentDropZoneProps } {
  const { canDropPaste, addFiles } = opts
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      dragDepth.current = 0
      setDragActive(false)
      if (!canDropPaste) return
      const files = dataTransferFiles(e.dataTransfer)
      if (files.length === 0) return
      e.preventDefault()
      void addFiles(files)
    },
    [canDropPaste, addFiles]
  )
  const handleDragEnter = useCallback(() => {
    if (!canDropPaste) return
    dragDepth.current += 1
    setDragActive(true)
  }, [canDropPaste])
  const handleDragLeave = useCallback(() => {
    if (!canDropPaste) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }, [canDropPaste])
  return {
    dragActive,
    dropProps: {
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: canDropPaste ? (e) => e.preventDefault() : undefined,
      onDrop: handleDrop
    }
  }
}
