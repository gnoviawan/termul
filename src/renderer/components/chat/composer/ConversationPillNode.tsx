import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from '@tiptap/react'
import { conversationToken } from '@/lib/skill-tokens'
import { cn } from '@/lib/utils'
import { ConversationChip } from '../ConversationChip'

export const ConversationPill = Node.create({
  name: 'conversationPill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      title: { default: '' },
      sessionId: { default: '' }
    }
  },
  parseHTML() {
    return []
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-conversation-pill': '',
        'data-conversation-id': node.attrs.sessionId
      })
    ]
  },
  renderText({ node }) {
    return conversationToken(String(node.attrs.title ?? ''), String(node.attrs.sessionId ?? ''))
  },
  addNodeView() {
    return ReactNodeViewRenderer(ConversationPillNodeView)
  }
})

function ConversationPillNodeView({ node, selected }: ReactNodeViewProps): React.JSX.Element {
  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        'inline-flex align-baseline leading-none',
        selected && 'ring-2 ring-primary/40'
      )}
      data-conversation-pill="true"
      data-conversation-id={String(node.attrs.sessionId ?? '')}
    >
      <ConversationChip title={String(node.attrs.title ?? '')} />
    </NodeViewWrapper>
  )
}
