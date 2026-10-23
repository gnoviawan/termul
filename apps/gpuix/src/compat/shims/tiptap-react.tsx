/**
 * `@tiptap/react` stand-in. ProseMirror needs a live, contenteditable DOM, so
 * on GPUIX no editor is created: `useEditor` returns `null` (the composer
 * already handles the not-yet-created editor) and `EditorContent` paints the
 * empty host. The native composer override replaces the files that use it.
 */

import { forwardRef, type ReactNode } from 'react'
import { compatWarn } from '../log'

// biome-ignore lint/suspicious/noExplicitAny: stand-in props are passed through untyped
type AnyProps = { children?: ReactNode; [prop: string]: any }

export function useEditor(): null {
  compatWarn('library-stub', '@tiptap/react useEditor')
  return null
}

export function useCurrentEditor(): { editor: null } {
  return { editor: null }
}

export const EditorContent = forwardRef<HTMLDivElement, AnyProps>(function EditorContent(
  { editor: _editor, innerRef: _innerRef, children: _children, ...props },
  ref
) {
  return <div ref={ref} {...props} />
})

export const NodeViewWrapper = forwardRef<HTMLDivElement, AnyProps>(function NodeViewWrapper(
  { as: Tag = 'div', children, ...props },
  ref
) {
  return (
    <Tag ref={ref} {...props}>
      {children}
    </Tag>
  )
})

export const NodeViewContent = NodeViewWrapper

export function ReactNodeViewRenderer(): () => null {
  return () => null
}

export class ReactRenderer {
  element = null
  ref = null
  updateProps(): void {}
  destroy(): void {}
}

export type ReactNodeViewProps = Record<string, unknown>
