/**
 * Shared surface and row styles for dropdown, context and select menus, and
 * for the hand-rolled pickers (composer selectors, launcher pickers, the
 * composer slash/mention menu).
 *
 * Rows sit on `bg-popover`, so the highlight is a foreground wash, not
 * `bg-secondary`: in Termul Dark `secondary` and `popover` resolve to the
 * same colour and the highlight disappears. A foreground wash also reads in
 * Termul Light (ink on paper) without the maroon `--accent` fill.
 * See docs/design/overlays.md (Menus).
 */

/** Menu shell. 12px radius, 4px padding — rows use 8px (12 − 4). */
export const MENU_CONTENT_CLASS =
  'z-50 min-w-[8rem] overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-md'

/**
 * Open/close and side-aware entrance motion for a Radix menu shell. The trailing
 * `motion-reduce:animate-none!` skips it under reduced motion: it is important
 * on purpose, because `data-[state=open]:animate-in` compiles to a rule that
 * outranks a bare `motion-reduce:animate-none`, and Radix `Presence` must not
 * wait on an animation that never runs. Dropdown, select and context menus all
 * compose this constant, so a new menu inherits the rule.
 */
export const MENU_MOTION_CLASS =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 motion-reduce:animate-none!'

/** Pointer or keyboard highlight on a menu row. */
export const MENU_HIGHLIGHT_CLASS = 'focus:bg-foreground/[0.06] focus:text-foreground'

/** One row for every menu kind. Height 32, text 12, radius 8. */
export const MENU_ITEM_CLASS = `relative flex min-h-8 cursor-default select-none items-center rounded-lg px-2 py-1.5 text-xs outline-none transition-colors duration-150 ease-out data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${MENU_HIGHLIGHT_CLASS}`

/** Sub-menu trigger stays highlighted while its sub-menu is open. */
export const MENU_SUB_TRIGGER_OPEN_CLASS = 'data-[state=open]:bg-foreground/[0.06]'

/** Slot for the checked `Check` on a `pl-8` checkbox, radio or select row. */
export const MENU_INDICATOR_CLASS = 'absolute left-2 flex h-3.5 w-3.5 items-center justify-center'

/** Group label: the `.label-panel` role (11px / semibold / tracked) with row padding. */
export const MENU_LABEL_CLASS = 'label-panel px-2 pb-1 pt-2'

/** Hairline between groups, edge to edge inside the 4px shell padding. */
export const MENU_SEPARATOR_CLASS = '-mx-1 my-1 h-px bg-border'

/** Keyboard shortcut hint at the row end. */
export const MENU_SHORTCUT_CLASS = 'ml-auto pl-4 text-2xs text-muted-foreground'

/**
 * Hand-rolled picker option (`<button>`): pointer hover only. Height comes
 * from {@link menuOptionRowClass} or the call site.
 */
export const MENU_OPTION_ROW_CLASS =
  'flex w-full items-start gap-2 rounded-lg px-2 text-left text-xs text-foreground hover:bg-foreground/[0.06]'

/**
 * Index-driven highlight on a picker option, for listboxes that keep focus in
 * another element (the composer menu keeps it in the editor).
 */
export const MENU_ACTIVE_ROW_CLASS = 'bg-foreground/[0.06]'

/** Picker option row: 32px like a menu item, or a 44px touch row on mobile. */
export function menuOptionRowClass(touch: boolean): string {
  return `${MENU_OPTION_ROW_CLASS} ${touch ? 'min-h-11 py-2.5' : 'min-h-8 py-1.5'}`
}

/** Text size for a picker search field. 16px on touch keeps iOS Safari from zooming in. */
export function pickerSearchTextClass(touch: boolean): string {
  return touch ? 'text-base' : 'text-xs'
}
