/**
 * Asked when a canvas could not be saved before it unmounts (project close,
 * app quit; spine AD-31): retry the save, discard the unsaved changes, or
 * keep editing and cancel the close.
 */

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useCanvasUnmountPrompt } from '@/lib/canvas-unmount-flow'

export function CanvasUnmountDialog(): React.JSX.Element {
  const question = useCanvasUnmountPrompt((state) => state.question)
  const answer = useCanvasUnmountPrompt((state) => state.answer)

  return (
    <ConfirmDialog
      isOpen={question !== null}
      title="Canvas not saved"
      message={
        question
          ? `"${question.docName}" could not be saved before closing: ${question.message}`
          : ''
      }
      confirmLabel="Retry"
      cancelLabel="Keep editing"
      secondaryAction={{ label: 'Discard changes', onClick: () => answer('discard') }}
      onConfirm={() => answer('retry')}
      onCancel={() => answer('keep')}
    />
  )
}
