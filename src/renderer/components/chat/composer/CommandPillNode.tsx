import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from '@tiptap/react'
import { CMD_TOKEN_END, CMD_TOKEN_START } from '@/lib/skill-tokens'
import { cn } from '@/lib/utils'
import { CommandChipLink } from '../skill-file-links'

/**
 * Inline atomic Tiptap node for a slash COMMAND "pill" (e.g. `/compact`).
 * Mirrors `SkillPillNode`: `atom:true`, `group:'inline'`,
 * `NodeViewWrapper as="span"`, `parseHTML()->[]` (no untrusted-HTML pill
 * creation), `renderText` emits the `\uE004<name>\uE005` sentinel. The sentinel
 * pair is distinct from the skill sentinels (`\uE000/\uE001`) so
 * `parseSkillSegments` (and the skill wire framer / timeline renderer) never
 * see command tokens.
 *
 * The visible chip is `CommandChip` (terminal icon, muted `/name`). A skill
 * pill stays `Sparkles` and accent, with the name and no slash. The timeline
 * uses the same chip, so the composer and the user bubble match. Backspace
 * with the caret immediately after the pill removes the whole atom node
 * (handled by the editor's keymap plugin, see `ChatComposerEditor`).
 *
 * Wire contract: at send, `buildPromptParts` replaces the token with `/name`
 * in the sentence where the user typed it. The command is not moved to the
 * front. Single-command invariant: `insertCommandToken` rejects a second
 * command token if one already exists.
 */
export const CommandPill = Node.create({
  name: 'commandPill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-command-name') ?? ''
      }
    }
  },
  // No parseHTML rules: pill nodes are not parsed from clipboard HTML. The only
  // re-entry path is the `\uE004` sentinel in `text/plain` (handled by
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
        'data-command-pill': '',
        'data-command-name': node.attrs.name
      })
    ]
  },
  renderText({ node }) {
    // Plain-text serialization (used by `editor.getText()`). The composer's
    // load-bearing serializer lives in `doc-to-prompt.ts` (it emits the sentinel
    // token format the wire builder consumes); this is only the fallback path.
    return `${CMD_TOKEN_START}${node.attrs.name ?? ''}${CMD_TOKEN_END}`
  },
  addNodeView() {
    return ReactNodeViewRenderer(CommandPillNodeView)
  }
})

/**
 * React NodeView for the command pill. Renders `<CommandChip>` (terminal icon,
 * muted `/name`) through `CommandChipLink`, which makes a skill-backed command
 * open its `SKILL.md`. `NodeViewWrapper as="span"` keeps it inline (the node is
 * `inline: true`); the `selected` ring + `data-command-*` attrs live on the
 * wrapper so ProseMirror selection state and clipboard serialization work
 * without touching the chip visual.
 */
function CommandPillNodeView({ node, selected }: ReactNodeViewProps): React.JSX.Element {
  const attrs = node.attrs as { name?: string }
  const name = String(attrs.name ?? '')
  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        'inline-flex align-baseline leading-none',
        selected && 'ring-2 ring-primary/40'
      )}
      data-command-pill="true"
      data-command-name={name}
    >
      <CommandChipLink name={name} surface="composer" />
    </NodeViewWrapper>
  )
}
