/**
 * Size tokens for the model picker. The list rows, the section labels and the
 * Edit flyout all read these. The flyout is portaled out of the panel, so it
 * inherits nothing from it; sharing the classes is what keeps the two equal.
 */
export const PICKER_ROW = {
  text: 'text-sm',
  height: 'h-7',
  heightTouch: 'min-h-11',
  padX: 'px-2',
  gap: 'gap-2',
  radius: 'rounded-md'
} as const

/**
 * A value on the selected row (its Thinking level, on the Edit button):
 * smaller and muted, and it never shrinks, so the name truncates first.
 */
export const PICKER_ROW_VALUE =
  'shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground'

/** Icon sizes in a row: the agent glyph and the Fast bolt (16), the check (14). */
export const PICKER_ICON = { glyph: 16, check: 14 } as const

/** A group label: Favorites and the agent name in the list, Thinking and Context in the flyout. */
export const PICKER_LABEL = 'truncate px-2 pb-1 pt-2 text-xs text-muted-foreground'

/** The surface both the panel and the flyout sit on. */
export const PICKER_SURFACE = {
  radius: 'rounded-xl',
  padding: 'p-1',
  paddingTouch: 'px-3 pb-3',
  separator: 'border-t border-border'
} as const

export function pickerRowHeight(touch: boolean): string {
  return touch ? PICKER_ROW.heightTouch : PICKER_ROW.height
}
