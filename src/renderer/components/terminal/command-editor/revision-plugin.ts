import { ViewPlugin, type ViewUpdate } from '@codemirror/view'
import {
  bumpEditorRevision,
  clearEditorRevision,
  readEditorRevision
} from '@/lib/command-lifecycle/editor-revision'

export interface EditorRevisionSnapshot {
  draft: string
  cursor: number
  revision: number
}

export { clearEditorRevision, readEditorRevision }

export function revisionPlugin(
  terminalId: string,
  onRevision: (snapshot: EditorRevisionSnapshot) => void
) {
  return ViewPlugin.define(() => ({
    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) return
      const revision = bumpEditorRevision(terminalId)
      onRevision({
        draft: update.state.doc.toString(),
        cursor: update.state.selection.main.head,
        revision
      })
    }
  }))
}
