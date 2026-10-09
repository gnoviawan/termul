import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

/**
 * Extra classes that turn the 24px status-bar slot into a 44×44 border box
 * (#881). Coarse pointers only (phones, including landscape). A narrow
 * fine-pointer window keeps the 24px slot: the same bar is also rendered in
 * the desktop layout, where a viewport-width rule would overlay content
 * above the bar.
 *
 * `-my-2.5` cancels the extra layout height so the slot stays 24px in the
 * 28px (h-7) bar.
 * `-translate-y-2.5` shifts that box up by 10px: the shell column is
 * `overflow-hidden` and the bar sits on its bottom edge, so a centered 44px
 * control would lose its lower 10px to the clip. Pair the glyph with
 * {@link STATUS_BAR_HIT_GLYPH} so the icon stays centered in the bar.
 * `after:inset-0` drops the desktop slop once the box itself is 44px, so
 * neighboring controls do not share a hit region.
 */
const STATUS_BAR_TOUCH_HIT =
  'pointer-coarse:size-11 pointer-coarse:-my-2.5 pointer-coarse:-translate-y-2.5 pointer-coarse:after:inset-0'

/** Open-popover tint shared by every status-bar popover trigger. */
export const STATUS_BAR_OPEN_CLASS =
  'data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground'

/** Neutral hover wash for status-bar text items (quiet bar). */
export const STATUS_BAR_HOVER_CLASS =
  'transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground'

/** 24px status-bar text item: icon + label row. Hover stays at the call site. */
export const STATUS_BAR_ITEM_CLASS =
  'flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2'

/**
 * Status-bar icon button (quiet bar): 24px slot, neutral hover wash and
 * focus ring. The invisible ::after pads the tap target without stretching
 * the 28px bar (#859). Coarse pointers use {@link STATUS_BAR_TOUCH_HIT}.
 */
export const STATUS_BAR_HIT_TARGET = cn(
  QUIET_ICON_BUTTON_CLASS,
  'relative flex size-6 shrink-0',
  STATUS_BAR_OPEN_CLASS,
  "after:absolute after:-inset-2 after:content-['']",
  STATUS_BAR_TOUCH_HIT
)

/** Undoes the button translate so the glyph stays centered in the 28px bar. */
export const STATUS_BAR_HIT_GLYPH = 'inline-flex pointer-coarse:translate-y-2.5'
