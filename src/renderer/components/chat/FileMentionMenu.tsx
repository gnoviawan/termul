import { forwardRef, type RefObject } from 'react'
import { ChevronLeft, File, Folder, FolderTree, type TermulIcon } from '@/components/icons'
import { ComposerMenu, type ComposerMenuItem, type ComposerMenuSection } from './composer-menu'
import type { MentionItem, MentionMenuView, MentionRow } from './mention-menu-model'
import { useTapSelect } from './use-tap-select'

/** Default empty-state copy; the picker lists files and folders (gh-896). */
export const MENTION_EMPTY_LABEL = 'No files or folders match. Try another name.'
/** Loading-state copy shown while a filename-search stream is in flight. */
export const MENTION_SEARCHING_LABEL = 'Searching files and folders…'

export type FileMentionMenuHandle = {
  move: (delta: 1 | -1) => void
  selectHighlighted: () => boolean
  drillHighlighted: () => boolean
}

interface FileMentionMenuProps {
  menu: MentionMenuView
  onSelect: (row: MentionRow) => void
  onBack: () => void
  /** The composer editor that owns this listbox (for aria-controls/activedescendant). */
  inputRef?: RefObject<HTMLElement | null>
}

const ROW_ICON: Record<MentionRow['kind'], TermulIcon> = {
  category: FolderTree,
  'use-folder': Folder,
  file: File,
  dir: Folder
}

function toComposerItem(item: MentionItem): ComposerMenuItem {
  const { row } = item
  return {
    key: item.key,
    label: item.label,
    description: item.description,
    icon: ROW_ICON[row.kind],
    iconTile: row.kind === 'category',
    drill: row.kind === 'category' || row.kind === 'dir',
    dimmed: item.ignored,
    payload: row
  }
}

/**
 * Inline @ picker rendered above the chat composer: a drill-down stack of
 * panels over the shared {@link ComposerMenu} shell. See ADR 0003.
 */
export const FileMentionMenu = forwardRef<FileMentionMenuHandle, FileMentionMenuProps>(
  ({ menu, onSelect, onBack, inputRef }, ref) => {
    const tapSelect = useTapSelect()
    const sections: ComposerMenuSection[] = menu.sections.map((s) => ({
      id: s.id,
      heading: s.heading,
      notice: s.notice,
      items: s.items.map(toComposerItem)
    }))
    const header = menu.header && (
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Back from ${menu.header.title}`}
        {...tapSelect(onBack)}
        onMouseDown={(e) => e.preventDefault()}
        className="flex min-h-11 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-left text-xs @[400px]:min-h-8"
      >
        <ChevronLeft size={12} className="shrink-0 text-foreground" />
        <span className="shrink-0 font-semibold text-foreground">{menu.header.title}</span>
        {menu.header.crumb && (
          <span className="min-w-0 truncate text-muted-foreground">{menu.header.crumb}</span>
        )}
      </button>
    )

    return (
      <ComposerMenu
        key={menu.panelKey}
        ref={ref}
        sections={sections}
        emptyLabel={menu.emptyLabel}
        inputRef={inputRef}
        panel={{ header, enter: menu.enter }}
        onSelect={(_sectionId, cItem) => onSelect(cItem.payload as MentionRow)}
      />
    )
  }
)

FileMentionMenu.displayName = 'FileMentionMenu'
