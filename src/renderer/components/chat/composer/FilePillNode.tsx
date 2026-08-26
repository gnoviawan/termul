import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from '@tiptap/react'
import { FILE_TOKEN_END, FILE_TOKEN_SEP, FILE_TOKEN_START } from '@/lib/skill-tokens'
import { cn } from '@/lib/utils'
import { FileChip } from '../FileChip'

/**
 * Inline atomic Tiptap node for a file @-mention "pill". Mirrors
 * `SkillPillNode`/`CommandPillNode`: `atom:true`, `group:'inline'`,
 * `inline:true`, `NodeViewWrapper as="span"`, `parseHTML()->[]` (no
 * untrusted-HTML pill creation), `renderText` emits the `\uE006<display>
 * \u001F<absPath>\uE007` sentinel. The sentinel pair is distinct from the
 * skill (`\uE000/\uE001`) and command (`\uE004/\uE005`) sentinels so
 * `parseSkillSegments` (and the skill wire framer / timeline renderer) and
 * the command walk never see file tokens.
 *
 * Stores `display` + `absPath` as node attrs: `display` is the filename/relPath
 * shown in the pill; `absPath` is the absolute OS path the wire builder
 * resolves to a `file://` `resource_link` URI at send time. The render reuses
 * the shared `<FileChip>` component (`File` icon, muted
 * `border-border/60 bg-muted/60 text-muted-foreground`, `px-2`,
 * `align-baseline h-[1.1em]`) so the pill reads identically across the
 * composer, the mention menu, and the timeline — they share one visual source
 * of truth and cannot drift.
 *
 * `parseHTML` returns an empty list: pill nodes are NEVER created from
 * clipboard HTML (untrusted). Pills only re-enter the editor via the
 * `\uE006` sentinel in the clipboard's `text/plain` payload, which
 * `ChatComposerEditor.handlePaste` parses via `draftFromTokens`. This closes
 * the untrusted-HTML injection vector.
 */
export const FilePill = Node.create({
  name: 'filePill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      display: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-file-display') ?? ''
      },
      absPath: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-file-abspath') ?? ''
      }
    }
  },
  // No parseHTML rules: pill nodes are not parsed from clipboard HTML. The only
  // re-entry path is the `\uE006` sentinel in `text/plain` (handled by
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
        'data-file-pill': '',
        'data-file-display': node.attrs.display,
        'data-file-abspath': node.attrs.absPath
      })
    ]
  },
  renderText({ node }) {
    // Plain-text serialization (used by `editor.getText()`). The composer's
    // load-bearing serializer lives in `doc-to-prompt.ts` (it emits the
    // sentinel token format the wire builder consumes); this is only the
    // fallback path.
    return `${FILE_TOKEN_START}${node.attrs.display ?? ''}${FILE_TOKEN_SEP}${node.attrs.absPath ?? ''}${FILE_TOKEN_END}`
  },
  addNodeView() {
    return ReactNodeViewRenderer(FilePillNodeView)
  }
})

/**
 * React NodeView for the file pill. Renders the shared `<FileChip>` component
 * (the single source of truth for the file-chip visual — also used by the
 * timeline user-bubble) so the two surfaces cannot drift. `NodeViewWrapper
 * as="span"` keeps it inline (the node is `inline: true`); the `selected` ring
 * + `data-file-*` attrs live on the wrapper so ProseMirror selection state and
 * clipboard serialization work without touching the `FileChip` visual.
 */
function FilePillNodeView({ node, selected }: ReactNodeViewProps): React.JSX.Element {
  const attrs = node.attrs as { display?: string; absPath?: string }
  const display = String(attrs.display ?? '')
  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        'inline-flex align-baseline leading-none',
        selected && 'ring-2 ring-primary/40'
      )}
      data-file-pill="true"
      data-file-display={display}
      data-file-abspath={String(attrs.absPath ?? '')}
    >
      <FileChip name={display} />
    </NodeViewWrapper>
  )
}
