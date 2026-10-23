/** GPUIX twin of `components/chat/composer/insert-composer-trigger.ts`. */

import { logFrontendError } from '@/lib/log-api'
import type { ComposerEditor } from './editor-ops'

const LOG_SOURCE = 'composer-add-sheet'

export function blurComposerEditor(editor: ComposerEditor | null): void {
  if (editor?.isLive()) editor.blur()
}

/** Append a `@` or `/` trigger at the end of the draft so its menu opens. */
export function insertComposerTrigger(editor: ComposerEditor | null, trigger: '@' | '/'): boolean {
  if (!editor?.isLive() || !editor.isEditable()) {
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message: `Could not insert the '${trigger}' trigger: the composer editor is unavailable`
    })
    return false
  }
  editor.insertTrigger(trigger)
  return true
}
