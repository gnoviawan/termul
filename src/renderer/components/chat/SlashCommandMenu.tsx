import { SlidersHorizontal, Sparkles, TerminalSquare } from 'lucide-react'
import { forwardRef, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
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
  /** The composer textarea that owns this listbox (for aria-controls/activedescendant). */
  inputRef?: RefObject<HTMLElement | null>
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
  const selected = !isCommandOrSkill && item.selected
  return {
    key: itemKey(item),
    label,
    description: item.description,
    icon: Icon,
    // Skill rows share the accent `Sparkles` treatment with `SkillChip`
    // (composer overlay + timeline) so the skills icon reads consistently
    // across the picker and the chips. Commands/config/mode stay muted.
    iconClassName: item.kind === 'skill' ? 'text-primary' : undefined,
    selected,
    payload: item
  }
}

/**
 * Inline slash-command menu rendered above the chat input. A thin wrapper over
 * the shared {@link ComposerMenu} shell; the slash-specific part is the
 * SlashItem → ComposerMenuItem mapping (icon, `/<name>` label).
 */
export const SlashCommandMenu = forwardRef<SlashMenuHandle, SlashCommandMenuProps>(
  ({ sections, onSelect, inputRef }, ref) => {
    const { t } = useTranslation('chat')
    const composerSections: ComposerMenuSection[] = sections.map((s) => ({
      id: s.id,
      heading: s.heading,
      items: s.items.map(slashItemToComposer)
    }))

    return (
      <ComposerMenu
        ref={ref}
        sections={composerSections}
        emptyLabel={t('selectors.noCommands')}
        inputRef={inputRef}
        onSelect={(_sectionId, cItem) => onSelect(cItem.payload as SlashItem)}
      />
    )
  }
)

SlashCommandMenu.displayName = 'SlashCommandMenu'
