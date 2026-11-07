import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from '@tiptap/react'
import { TOOL_PILL_NODE } from '@/lib/composer/doc-to-prompt'
import { termulTool } from '@/lib/composer/termul-tools'
import { TOOL_TOKEN_END, TOOL_TOKEN_START } from '@/lib/composer/tool-tokens'
import { cn } from '@/lib/utils'
import { ToolChip } from '../ToolChip'

/**
 * Inline atom for a Termul tool pill. Like the other pills it is never parsed
 * from clipboard HTML; it re-enters only through its sentinel in `text/plain`.
 */
export const ToolPill = Node.create({
  name: TOOL_PILL_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { id: { default: '' } }
  },
  parseHTML() {
    return []
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-tool-pill': node.attrs.id })]
  },
  renderText({ node }) {
    return `${TOOL_TOKEN_START}${node.attrs.id ?? ''}${TOOL_TOKEN_END}`
  },
  addNodeView() {
    return ReactNodeViewRenderer(ToolPillNodeView)
  }
})

function ToolPillNodeView({ node, selected }: ReactNodeViewProps): React.JSX.Element {
  const id = String(node.attrs.id ?? '')
  const tool = termulTool(id)
  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        'inline-flex align-baseline leading-none',
        selected && 'ring-2 ring-primary/40'
      )}
      data-tool-pill={id}
    >
      {tool ? <ToolChip tool={tool} /> : id}
    </NodeViewWrapper>
  )
}
