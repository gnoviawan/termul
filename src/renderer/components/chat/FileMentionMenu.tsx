import { File } from 'lucide-react'
import { forwardRef, type RefObject } from 'react'
import { ComposerMenu, type ComposerMenuItem, type ComposerMenuSection } from './composer-menu'
import type { MentionMatch, MentionSection } from './mention-menu-model'

export type FileMentionMenuHandle = {
  move: (delta: 1 | -1) => void
  selectHighlighted: () => boolean
}

interface FileMentionMenuProps {
  sections: MentionSection[]
  onSelect: (match: MentionMatch) => void
  /** Override the empty-state label (e.g. "Searching files…" while walking). */
  emptyLabel?: string
  /** The composer textarea that owns this listbox (for aria-controls/activedescendant). */
  inputRef?: RefObject<HTMLTextAreaElement | null>
}

/**
 * Inline @-file mention picker rendered above the chat composer. A thin
 * wrapper over the shared {@link ComposerMenu} shell; the mention-specific
 * part is the MentionItem → ComposerMenuItem mapping (file icon, dimmed
 * ignored entries). See ADR 0003.
 */
export const FileMentionMenu = forwardRef<FileMentionMenuHandle, FileMentionMenuProps>(
  ({ sections, onSelect, emptyLabel, inputRef }, ref) => {
    const composerSections: ComposerMenuSection[] = sections.map((s) => ({
      id: s.id,
      heading: s.heading,
      items: s.items.map<ComposerMenuItem>((item) => ({
        key: item.key,
        label: item.label,
        description: item.description,
        icon: File,
        dimmed: item.ignored,
        payload: item.payload
      }))
    }))

    return (
      <ComposerMenu
        ref={ref}
        sections={composerSections}
        emptyLabel={emptyLabel ?? 'No matching files.'}
        inputRef={inputRef}
        onSelect={(_sectionId, cItem) => onSelect(cItem.payload as MentionMatch)}
      />
    )
  }
)

FileMentionMenu.displayName = 'FileMentionMenu'
