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

type EditContextHost = HTMLElement & { editContext?: EventTarget }

export function revisionPlugin(
  terminalId: string,
  onRevision: (snapshot: EditorRevisionSnapshot) => void
) {
  return ViewPlugin.define((view) => {
    let compositionActive = false
    let compositionChanged = false
    let destroyed = false
    let editContext: EventTarget | undefined
    let frame = 0

    const win = () => view.dom.ownerDocument.defaultView ?? window
    const publishComposition = () => {
      if (destroyed || !compositionActive || view.composing || view.compositionStarted) return
      compositionActive = false
      const revision = compositionChanged
        ? bumpEditorRevision(terminalId)
        : readEditorRevision(terminalId)
      compositionChanged = false
      onRevision({
        draft: view.state.doc.toString(),
        cursor: view.state.selection.main.head,
        revision
      })
    }
    const afterCompositionEnd = () => {
      if (destroyed) return
      queueMicrotask(() => {
        if (destroyed || !compositionActive) return
        win().cancelAnimationFrame(frame)
        frame = win().requestAnimationFrame(publishComposition)
      })
    }
    const onCompositionStart = () => {
      compositionActive = true
      compositionChanged = false
    }

    view.dom.addEventListener('compositionstart', onCompositionStart)
    view.dom.addEventListener('compositionend', afterCompositionEnd)
    queueMicrotask(() => {
      if (destroyed) return
      editContext = (view.contentDOM as EditContextHost).editContext
      editContext?.addEventListener('compositionstart', onCompositionStart)
      editContext?.addEventListener('compositionend', afterCompositionEnd)
    })

    return {
      update(update: ViewUpdate) {
        if (update.view.composing || update.view.compositionStarted) {
          if (!compositionActive) onCompositionStart()
          compositionChanged ||= update.docChanged || update.selectionSet
          return
        }
        if (compositionActive) {
          compositionChanged ||= update.docChanged || update.selectionSet
          win().cancelAnimationFrame(frame)
          frame = 0
          publishComposition()
          return
        }
        if (!update.docChanged && !update.selectionSet) return
        const revision = bumpEditorRevision(terminalId)
        onRevision({
          draft: update.state.doc.toString(),
          cursor: update.state.selection.main.head,
          revision
        })
      },
      destroy() {
        destroyed = true
        win().cancelAnimationFrame(frame)
        view.dom.removeEventListener('compositionstart', onCompositionStart)
        view.dom.removeEventListener('compositionend', afterCompositionEnd)
        editContext?.removeEventListener('compositionstart', onCompositionStart)
        editContext?.removeEventListener('compositionend', afterCompositionEnd)
      }
    }
  })
}
