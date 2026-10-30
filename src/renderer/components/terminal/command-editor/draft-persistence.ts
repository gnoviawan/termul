import { ViewPlugin } from '@codemirror/view'
import type { createCommandDraftStore } from '@/lib/command-lifecycle/draft-store'

type DraftStore = ReturnType<typeof createCommandDraftStore>
type EditContextHost = HTMLElement & { editContext?: EventTarget }

export function draftPersistence(terminalId: string, draftStore: DraftStore) {
  return ViewPlugin.define((view) => {
    let pending = false
    let destroyed = false
    let editContext: EventTarget | undefined
    let frame = 0

    const storeIfIdle = () => {
      if (destroyed || view.composing || view.compositionStarted || !pending) return
      pending = false
      draftStore.offer(terminalId, 'Editor', view.state.doc.toString())
    }

    // Wait for CodeMirror's microtask flush, then the Android flushSoon rAF.
    // EditContext compositionend does not dispatch a view update.
    const win = () => view.dom.ownerDocument.defaultView ?? window

    const afterCompositionEnd = () => {
      if (destroyed) return
      queueMicrotask(() => {
        if (destroyed) return
        win().cancelAnimationFrame(frame)
        frame = win().requestAnimationFrame(storeIfIdle)
      })
    }

    view.dom.addEventListener('compositionend', afterCompositionEnd)
    queueMicrotask(() => {
      if (destroyed) return
      editContext = (view.contentDOM as EditContextHost).editContext
      editContext?.addEventListener('compositionend', afterCompositionEnd)
    })

    return {
      update(update) {
        pending ||= update.docChanged
        if (view.composing || view.compositionStarted) {
          // EditContext applies text live; a deleting textupdate may end the
          // composition without a view update or DOM compositionend.
          if ((view.contentDOM as EditContextHost).editContext) queueMicrotask(storeIfIdle)
          return
        }
        storeIfIdle()
      },
      destroy() {
        destroyed = true
        win().cancelAnimationFrame(frame)
        view.dom.removeEventListener('compositionend', afterCompositionEnd)
        editContext?.removeEventListener('compositionend', afterCompositionEnd)
      }
    }
  })
}
