import { SlidersHorizontal, Sparkles, TerminalSquare } from 'lucide-react'
import { forwardRef } from 'react'
import { ComposerMenu, type ComposerMenuItem, type ComposerMenuSection } from './composer-menu'
import type { SlashItem, SlashSection } from './slash-menu-model'

export type SlashMenuHandle = {
  /** Move highlight. Returns true if handled. */
  move: (delta: 1 | -1) => void
  /** Select the highlighted item. Returns true if an item was selected. */
  selectHighlighted: () => boolean
}

interface SlashCommandMenuProps {
  sections: SlashSection[]
  onSelect: (item: SlashItem) => void
}

function itemKey(item: SlashItem): string {
  switch (item.kind) {
    case 'command':
      return `command:${item.name}`
    case 'config':
      return `config:${item.configId}:${item.valueId}`
    case 'mode':
      return `mode:${item.modeId}`
    case 'skill':
      return `skill:${item.name}`
  }
}

function slashItemToComposer(item: SlashItem): ComposerMenuItem {
  const isCommandOrSkill = item.kind === 'command' || item.kind === 'skill'
  const Icon =
    item.kind === 'command' ? TerminalSquare : item.kind === 'skill' ? Sparkles : SlidersHorizontal
  const label = isCommandOrSkill ? `/${item.name}` : item.label
  const selected = item.kind !== 'command' && item.kind !== 'skill' && item.selected
  return {
    key: itemKey(item),
    label,
    description: item.description,
    icon: Icon,
    selected,
    wrap: item.kind === 'skill',
    payload: item
  }
}

/**
 * Inline slash-command menu rendered above the chat input. A thin wrapper over
 * the shared {@link ComposerMenu} shell; the slash-specific part is the
 * SlashItem → ComposerMenuItem mapping (icon, `/<name>` label, skill wrap).
 */
export const SlashCommandMenu = forwardRef<SlashMenuHandle, SlashCommandMenuProps>(
  ({ sections, onSelect }, ref) => {
    const composerSections: ComposerMenuSection[] = sections.map((s) => ({
      id: s.id,
      heading: s.heading,
      items: s.items.map(slashItemToComposer)
    }))

    return (
      <ComposerMenu
        ref={ref}
        sections={composerSections}
        emptyLabel="No commands available."
        onSelect={(_sectionId, cItem) => onSelect(cItem.payload as SlashItem)}
      />
    )
  }
)

SlashCommandMenu.displayName = 'SlashCommandMenu'
