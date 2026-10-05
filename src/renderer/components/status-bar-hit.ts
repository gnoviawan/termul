import { cn } from '@/lib/utils'

/**
 * Extra classes that turn the 20px status-bar slot into a 44×44 border box
 * (#881). Coarse pointers only (phones, including landscape). A narrow
 * fine-pointer window keeps the 20px slot: the same bar is also rendered in
 * the desktop layout, where a viewport-width rule would overlay content
 * above the bar.
 *
 * `-my-2.5` cancels the extra layout height so the h-6 bar stays 24px.
 * `-translate-y-2.5` shifts that box up by 10px: the shell column is
 * `overflow-hidden` and the bar sits on its bottom edge, so a centered 44px
 * control would lose its lower 10px to the clip. Pair the glyph with
 * {@link STATUS_BAR_HIT_GLYPH} so the icon stays centered in the bar.
 * `after:inset-0` drops the desktop slop once the box itself is 44px, so
 * neighboring controls do not share a hit region.
 */
const STATUS_BAR_TOUCH_HIT =
  'pointer-coarse:size-11 pointer-coarse:-my-2.5 pointer-coarse:-translate-y-2.5 pointer-coarse:after:inset-0'

/**
 * Status-bar icon button. Desktop keeps the 20px slot; the invisible ::after
 * pads the tap target without stretching the 24px bar (#859). Coarse
 * pointers use {@link STATUS_BAR_TOUCH_HIT}.
 */
export const STATUS_BAR_HIT_TARGET = cn(
  'relative flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-primary-foreground/10',
  "after:absolute after:-inset-2 after:content-['']",
  STATUS_BAR_TOUCH_HIT
)

/** Undoes the button translate so the glyph stays centered in the 24px bar. */
export const STATUS_BAR_HIT_GLYPH = 'inline-flex pointer-coarse:translate-y-2.5'
