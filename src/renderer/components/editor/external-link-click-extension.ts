import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

function linkAnchor(view: EditorView, event: Event): HTMLAnchorElement | null {
  const target = event.target
  if (!(target instanceof Element)) return null
  const anchor = target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor || !view.dom.contains(anchor)) return null
  return anchor
}

/**
 * Routes link clicks in the markdown editor through the app's confirm dialog.
 *
 * Without it a click on a link opens it with no confirmation twice over:
 * tiptap's Link mark (`openOnClick`, BlockNote's default) calls `window.open`
 * on mouseup, and the Tauri opener plugin opens the `target="_blank"` anchor
 * on click. Running before Link (higher priority) and claiming the click
 * stops both; `onLinkClick` decides what happens next.
 */
export function createExternalLinkClickExtension(
  onLinkClick: (href: string, anchor: HTMLAnchorElement) => void
) {
  return Extension.create({
    name: 'termulExternalLinkClick',
    priority: 1000,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey('termulExternalLinkClick'),
          props: {
            // Claim the click so Link's `handleClick` never reaches `window.open`.
            handleClick: (view, _pos, event) => linkAnchor(view, event) !== null,
            handleDOMEvents: {
              click: (view, event) => {
                const anchor = linkAnchor(view, event)
                if (anchor === null) return false
                event.preventDefault()
                const href = anchor.getAttribute('href') ?? ''
                if (!href.startsWith('#')) onLinkClick(href, anchor)
                return true
              },
              auxclick: (view, event) => {
                if (linkAnchor(view, event) === null) return false
                event.preventDefault()
                return true
              }
            }
          }
        })
      ]
    }
  })
}
