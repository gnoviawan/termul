import { mergeAttributes, Node } from '@tiptap/core'
import {
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
  useEditorState
} from '@tiptap/react'
import { CONTEXT_PILL_NODE } from '@/lib/composer/doc-to-prompt'
import { contextFromAttrs, selectionContextToken } from '@/lib/composer/selection-context'
import { cn } from '@/lib/utils'
import { SelectionContextChip } from '../SelectionContextChip'

/**
 * Inline atomic Tiptap node for a selection context. Mirrors `FilePill`:
 * `atom`, inline, no `parseHTML` rules (clipboard HTML can never create one;
 * only the `\uE008` sentinel in `text/plain` can), and `renderText` emits the
 * display-string token. The chip number is the pill's position among the
 * context pills of the doc, so it updates when a pill before it is removed.
 */
export const SelectionContextPill = Node.create({
  name: CONTEXT_PILL_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      text: { default: '' },
      language: { default: null }
    }
  },
  parseHTML() {
    return []
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-context-pill': '' })]
  },
  renderText({ node }) {
    return selectionContextToken(contextFromAttrs(node.attrs))
  },
  addNodeView() {
    return ReactNodeViewRenderer(SelectionContextPillNodeView)
  }
})

function SelectionContextPillNodeView({
  node,
  editor,
  getPos,
  selected
}: ReactNodeViewProps): React.JSX.Element {
  const index = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const pos = getPos()
      if (!current || typeof pos !== 'number') return 1
      let before = 0
      current.state.doc.descendants((child, childPos) => {
        if (childPos >= pos) return false
        if (child.type.name === CONTEXT_PILL_NODE) before += 1
        return true
      })
      return before + 1
    }
  })
  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        'inline-flex align-baseline leading-none',
        selected && 'rounded-sm ring-2 ring-primary/40'
      )}
      data-context-pill="true"
    >
      <SelectionContextChip
        index={index}
        context={contextFromAttrs(node.attrs)}
        tabIndex={-1}
        forceOpen={selected}
      />
    </NodeViewWrapper>
  )
}
