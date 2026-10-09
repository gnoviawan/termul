/**
 * Shared class strings for panel chrome: sidebars, explorer, outline, Git
 * panel, settings and composer toggles. Same idiom as `menu-styles.ts`: plain constants that
 * call sites compose with `cn`. Height, width and padding stay at the call
 * site; these hold only the look that must stay the same everywhere.
 */

/** Neutral keyboard focus ring for quiet controls on panel surfaces. */
export const FOCUS_RING_CLASS =
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** Quiet icon button: muted glyph, foreground wash on hover. No size. */
export const QUIET_ICON_BUTTON_CLASS = `inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground ${FOCUS_RING_CLASS}`

/** 28px panel-header icon button. */
export const PANEL_ICON_BUTTON_CLASS = `${QUIET_ICON_BUTTON_CLASS} size-7`

/** 40px panel header: `.label-panel` at the start, icon buttons at the end. */
export const PANEL_HEADER_CLASS = 'flex h-10 shrink-0 items-center justify-between pl-4 pr-1.5'

/** Panel text field: card fill, hairline border, neutral focus border. */
export const PANEL_FIELD_CLASS =
  'rounded-lg border border-border bg-card text-xs text-foreground outline-none transition-colors duration-150 ease-out placeholder:text-muted-foreground focus:border-muted-foreground/60'

/** 13px search glyph inside a `relative` wrapper around a panel field. */
export const PANEL_FIELD_ICON_CLASS =
  'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground'

/** Segmented track on a background or card surface. */
export const SEGMENTED_TRACK_CLASS =
  'flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5'

/** One segment in a {@link SEGMENTED_TRACK_CLASS} track. Active = keycap. */
export function segmentClass(active: boolean): string {
  return `flex items-center rounded-md px-2 text-xs font-medium transition-colors duration-150 ease-out ${FOCUS_RING_CLASS} ${
    active ? 'keycap text-foreground' : 'text-muted-foreground hover:text-foreground'
  }`
}

/**
 * Bordered on/off toggle (option pills, multi-select answers). Pressed is a
 * foreground wash, not a keycap: it also sits on popover and card surfaces.
 * Shape and size stay at the call site.
 */
export function pressedToggleClass(pressed: boolean): string {
  return pressed
    ? 'border-border bg-foreground/10 text-foreground'
    : 'border-border text-muted-foreground hover:bg-foreground/[0.03]'
}
