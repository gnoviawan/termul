import { useEffect, useRef } from 'react'
import { Bug, Palette, SlidersHorizontal } from '@/components/icons'
import { RailButton, type RailButtonSize, railButtonClass } from '@/components/shell/rail-button'
import { useShortcutLabel } from '@/components/shell/use-shortcut-label'
import { TitleBarShortcutsPopover } from '@/components/TitleBarShortcutsPopover'
import { cn } from '@/lib/utils'
import { useReportBugStore } from '@/stores/report-bug-store'
import { useSettingsModalStore, useSettingsModalView } from '@/stores/settings-modal-store'

interface RailFooterProps {
  isShortcutsOpen: boolean
  onShortcutsOpenChange: (open: boolean) => void
  isThemePickerOpen: boolean
  onToggleThemePicker?: () => void
}

interface RailUtilityButtonsProps {
  isShortcutsOpen: boolean
  onShortcutsOpenChange: (open: boolean) => void
  isThemePickerOpen: boolean
  onToggleThemePicker?: () => void
  /** `sm` (28px) in the expanded footer row, `md` (36px) in the collapsed Rail. */
  size: RailButtonSize
  className?: string
}

/**
 * The Theme picker and Shortcuts buttons, shared by the expanded footer and
 * the collapsed Rail. Closing the picker or the shortcuts popover returns
 * focus to its button when focus fell to the page body.
 */
export function RailUtilityButtons({
  isShortcutsOpen,
  onShortcutsOpenChange,
  isThemePickerOpen,
  onToggleThemePicker,
  size,
  className
}: RailUtilityButtonsProps): React.JSX.Element {
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
    <div ref={buttonsRef} className={cn('flex shrink-0 items-center', className)}>
      <RailButton
        label="Color themes"
        size={size}
        aria-label="Color themes"
        pressed={onToggleThemePicker ? isThemePickerOpen : undefined}
        disabled={!onToggleThemePicker}
        onClick={() => onToggleThemePicker?.()}
      >
        <Palette size={16} />
      </RailButton>

      <TitleBarShortcutsPopover
        buttonClassName={railButtonClass(isShortcutsOpen, size)}
        open={isShortcutsOpen}
        onOpenChange={onShortcutsOpenChange}
        restoreFocusOnClose
      />
    </div>
  )
}

/**
 * Expanded Rail footer, one row of 28px icon buttons: Settings at the left
 * (centered on the Rail icon column, x = 24), then the Theme picker and
 * Shortcuts grouped at the right.
 */
export function RailFooter({
  isShortcutsOpen,
  onShortcutsOpenChange,
  isThemePickerOpen,
  onToggleThemePicker
}: RailFooterProps): React.JSX.Element {
  const settingsView = useSettingsModalView()
  const settingsShortcut = useShortcutLabel('settings')

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
      <RailButton
        label="Report a bug"
        size="sm"
        aria-label="Report a bug"
        onClick={() => useReportBugStore.getState().openReport()}
      >
        <Bug size={16} />
      </RailButton>
      <div className="min-w-0 flex-1" />

      <RailUtilityButtons
        isShortcutsOpen={isShortcutsOpen}
        onShortcutsOpenChange={onShortcutsOpenChange}
        isThemePickerOpen={isThemePickerOpen}
        onToggleThemePicker={onToggleThemePicker}
        size="sm"
        className="gap-0.5"
      />
    </div>
  )
}
