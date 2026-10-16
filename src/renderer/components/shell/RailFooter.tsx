import { useEffect, useRef } from 'react'
import { Palette, SlidersHorizontal } from '@/components/icons'
import { RailButton, railButtonClass } from '@/components/shell/rail-button'
import { useShortcutLabel } from '@/components/shell/use-shortcut-label'
import { TitleBarShortcutsPopover } from '@/components/TitleBarShortcutsPopover'
import { useSettingsModalStore, useSettingsModalView } from '@/stores/settings-modal-store'

interface RailFooterProps {
  isShortcutsOpen: boolean
  onShortcutsOpenChange: (open: boolean) => void
  isThemePickerOpen: boolean
  onToggleThemePicker?: () => void
}

/**
 * Expanded Rail footer, one row of 28px icon buttons: Settings at the left
 * (centered on the Rail icon column, x = 24), then the Theme picker and
 * Shortcuts grouped at the right. Closing the picker or the shortcuts
 * popover returns focus to its button when focus fell to the page body.
 */
export function RailFooter({
  isShortcutsOpen,
  onShortcutsOpenChange,
  isThemePickerOpen,
  onToggleThemePicker
}: RailFooterProps): React.JSX.Element {
  const settingsView = useSettingsModalView()
  const settingsShortcut = useShortcutLabel('settings')
  const buttonsRef = useRef<HTMLDivElement>(null)
  const wasThemePickerOpen = useRef(false)

  useEffect(() => {
    const wasOpen = wasThemePickerOpen.current
    wasThemePickerOpen.current = isThemePickerOpen
    if (!wasOpen || isThemePickerOpen) return
    // The picker unmounts with the store flag; wait one frame so the browser
    // has moved focus to the body before deciding whether to restore it.
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body) return
      buttonsRef.current
        ?.querySelector<HTMLButtonElement>('button[aria-label="Color themes"]')
        ?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [isThemePickerOpen])

  return (
    // `pl-2.5` puts the 28px Settings button's center at x = 24 (the icon
    // column); `pr-1.5` lines Shortcuts up with the header's Rail toggle.
    <div className="flex shrink-0 items-center gap-0.5 pb-2 pl-2.5 pr-1.5 pt-1">
      <RailButton
        label="Settings"
        hint={settingsShortcut}
        size="sm"
        aria-label="Settings"
        pressed={settingsView === 'app'}
        onClick={() => useSettingsModalStore.getState().openApp()}
      >
        <SlidersHorizontal size={16} />
      </RailButton>
      <div className="min-w-0 flex-1" />

      <div ref={buttonsRef} className="flex shrink-0 items-center gap-0.5">
        <RailButton
          label="Color themes"
          size="sm"
          aria-label="Color themes"
          pressed={onToggleThemePicker ? isThemePickerOpen : undefined}
          disabled={!onToggleThemePicker}
          onClick={() => onToggleThemePicker?.()}
        >
          <Palette size={16} />
        </RailButton>

        <TitleBarShortcutsPopover
          buttonClassName={railButtonClass(isShortcutsOpen, 'sm')}
          open={isShortcutsOpen}
          onOpenChange={onShortcutsOpenChange}
          restoreFocusOnClose
        />
      </div>
    </div>
  )
}
