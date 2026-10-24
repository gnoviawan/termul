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
 * The model name's pull toward the agent glyph: 2px less than `PICKER_ROW.gap`,
 * so a long name like "Claude 4.7 Opus Thinking" fits beside Extra High.
 */
export const PICKER_ROW_NAME_PULL = '-ml-0.5'

/**
 * A value on the selected row (its Thinking level, on the Edit button):
 * smaller and muted, and it never shrinks, so the name truncates first.
 */
export const PICKER_ROW_VALUE =
  'shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground'

/**
 * The selected model row's fill, and the left rail's active agent tab: the
 * popover's active-segment fill (docs/design/colors.md). Both read this, so
 * the active model reads like the active agent and the two cannot drift.
 */
export const PICKER_ROW_SELECTED = 'bg-foreground/10'

/**
 * The selected row's outer box: the fill, kept under hover. It goes last in
 * `cn`, so tailwind-merge drops the box's own `hover:bg-row-hover` (and the
 * open flyout's `bg-row-hover`). The hover half stays literal for Tailwind.
 */
export const PICKER_ROW_SELECTED_BOX = `${PICKER_ROW_SELECTED} hover:bg-foreground/10`

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

/**
 * Edit's motion when a pick moves it to another row. It enters by sliding 6px
 * in from the right as it fades in (200ms, `--ease-drawer`). It leaves faster
 * and more quietly: a 4px nudge and fade (150ms ease-in), then it unmounts.
 * Only transform and opacity animate, through transitions from
 * `@starting-style`, so a second quick pick retargets them. Nothing moves on
 * the panel's first paint or under reduced motion. Class strings stay literal
 * so Tailwind finds them; `exitMs` must match the `duration-150` in `exit`.
 */
export const PICKER_EDIT_MOTION = {
  exitMs: 150,
  enter:
    'transition-[color,opacity,translate] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] starting:translate-x-1.5 starting:opacity-0 motion-reduce:transition-none',
  exit: 'pointer-events-none translate-x-1 opacity-0 transition-[opacity,translate] duration-150 ease-[cubic-bezier(0.4,0,1,1)] starting:translate-x-0 starting:opacity-100 motion-reduce:hidden'
} as const

/**
 * The star's move when a pick brings Edit to its row or takes it away (a FLIP
 * on transform only). Beside an entering Edit it slides over on Edit's own
 * timing, as one unit. Beside a leaving one it holds still while the copy
 * fades (`PICKER_EDIT_MOTION.exitMs`), so it never runs over that copy's text,
 * then settles into the freed room: quicker, and ease-in-out, as it is
 * already on screen. Nothing moves under reduced motion.
 */
export const PICKER_STAR_MOTION = {
  enter: { ms: 200, ease: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  settle: { ms: 150, ease: 'cubic-bezier(0.645, 0.045, 0.355, 1)' }
} as const

export function pickerRowHeight(touch: boolean): string {
  return touch ? PICKER_ROW.heightTouch : PICKER_ROW.height
}
