import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from '@tiptap/react'
import { cn } from '@/lib/utils'
import { SkillChip } from '../SkillChip'

/**
 * Inline atomic Tiptap node for an Agent Skill "pill". Replaces the
 * transparent-textarea overlay: the pill is now a real inline DOM node, so the
 * caret sits flush against its right edge by construction (no canvas padding,
 * no `Math.round` residual). Backspace with the caret immediately after the
 * pill removes the whole atom node (handled by the editor's keymap plugin, see
 * `ChatComposerEditor`).
 *
 * Stores `name` + `path` as node attrs (`path` is informational — the wire
 * builder resolves paths from `skillPathsRef` at send time, so the wire payload
 * stays byte-identical to the pre-refactor surface). The render reuses the
 * `SkillChip` component (`Sparkles` icon, `px-2`, `align-baseline h-[1.1em]`,
 * accent color) so the pill reads identically across the composer, the slash
 * menu, and the timeline — they share one visual source of truth and cannot
 * drift.
 *
 * `parseHTML` returns an empty list: pill nodes are NEVER created from
 * clipboard HTML (untrusted). Pills only re-enter the editor via the
 * `\uE000<name>\uE001` sentinel in the clipboard's `text/plain` payload, which
 * `ChatComposerEditor.handlePaste` parses via `draftFromTokens`. This closes
 * the untrusted-HTML injection vector (a malicious clipboard carrying
 * `<span data-skill-pill>` cannot inject a pill node).
 */
export const SkillPill = Node.create({
  name: 'skillPill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-skill-name') ?? ''
      },
      path: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-skill-path') ?? ''
      }
    }
  },
  // No parseHTML rules: pill nodes are not parsed from clipboard HTML. The only
  // re-entry path is the `\uE000` sentinel in `text/plain` (handled by
  // `ChatComposerEditor.handlePaste` → `draftFromTokens`), which constructs
  // pill nodes programmatically. Returning `[]` ensures ProseMirror's default
  // HTML paste handler never creates a pill from untrusted markup.
  parseHTML() {
    return []
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-skill-pill': '',
        'data-skill-name': node.attrs.name,
        'data-skill-path': node.attrs.path
      })
    ]
  },
  renderText({ node }) {
    // Plain-text serialization (used by `editor.getText()`). The composer's
    // load-bearing serializer lives in `doc-to-prompt.ts` (it emits the sentinel
    // token format the wire builder consumes, including the padding block); this
    // is only the fallback path.
    return `\uE000${node.attrs.name ?? ''}\uE001`
  },
  addNodeView() {
    return ReactNodeViewRenderer(SkillPillNodeView)
  }
})

/**
 * React NodeView for the skill pill. Renders the shared `<SkillChip>` component
 * (the single source of truth for the chip visual — also used by the slash-menu
 * skill row and the timeline user-bubble) so the three surfaces cannot drift.
 * `NodeViewWrapper as="span"` keeps it inline (the node is `inline: true`); the
 * `selected` ring + `data-skill-*` attrs live on the wrapper so ProseMirror
 * selection state and clipboard serialization work without touching the
 * `SkillChip` visual.
 */
function SkillPillNodeView({ node, selected }: ReactNodeViewProps): React.JSX.Element {
  const attrs = node.attrs as { name?: string; path?: string }
  const name = String(attrs.name ?? '')
  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        'inline-flex align-baseline leading-none',
        selected && 'ring-2 ring-primary/40'
      )}
      data-skill-pill="true"
      data-skill-name={name}
      data-skill-path={String(attrs.path ?? '')}
    >
      <SkillChip name={name} />
    </NodeViewWrapper>
  )
}
