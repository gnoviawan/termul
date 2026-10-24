/**
 * Shared class strings for panel chrome: sidebars, explorer, outline, Git
 * panel, settings and composer toggles. Same idiom as `menu-styles.ts`: plain constants that
 * call sites compose with `cn`. Height, width and padding stay at the call
 * site; these hold only the look that must stay the same everywhere.
 */

/**
 * Keyboard focus, one look everywhere: a 2px `--focus-ring` edge (the theme
 * ink by default). Rings ride Tailwind's box-shadow stack, so they merge with
 * `shadow-*` on the same element instead of replacing it. `outline-hidden`
 * keeps a system outline in forced-colors mode, where box-shadow rings are
 * dropped.
 */
export const FOCUS_RING_CLASS =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring'

/**
 * {@link FOCUS_RING_CLASS} drawn inset on an `::after` overlay, for a control
 * whose own box is covered by an absolute child (the active tab's keycap) or
 * clipped by an `overflow-hidden` parent. The control needs `relative`.
 */
export const FOCUS_RING_OVERLAY_CLASS =
  "focus-visible:outline-hidden after:pointer-events-none after:absolute after:inset-0 after:z-[2] after:rounded-[inherit] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-focus-ring"

/**
 * Focus for a bordered (or underlined) text field or select: the hairline
 * turns `--focus-ring` and a 1px ring outside it brings the edge to 2px.
 */
export const FIELD_FOCUS_CLASS =
  'focus-visible:outline-hidden focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring'

/**
 * Focus for a field whose wrapper draws the edge, such as a search band: the
 * field adds no edge of its own. Pair the wrapper with {@link BAND_FOCUS_CLASS}.
 */
export const INNER_FIELD_FOCUS_CLASS = 'focus-visible:outline-hidden'

/** Search band whose bottom hairline is the field edge: it turns `--focus-ring` while the field has focus. */
export const BAND_FOCUS_CLASS = 'focus-within:border-focus-ring'

/**
 * Composer card and the prompt panels that replace it: the field focus edge,
 * on `focus-within` because the editor sits inside the card. The ring joins
 * `shadow-composer` in one box-shadow list.
 */
export const COMPOSER_FOCUS_CLASS =
  'focus-within:border-focus-ring focus-within:ring-1 focus-within:ring-focus-ring'

/**
 * {@link COMPOSER_FOCUS_CLASS} for a prompt card whose options are buttons:
 * the edge lights only while a child matches `:focus-visible`, so a mouse
 * click on an option does not ring the whole card. A text field inside still
 * lights it, since browsers treat a focused text field as `:focus-visible`.
 */
export const PROMPT_CARD_FOCUS_CLASS =
  'has-[:focus-visible]:border-focus-ring has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-focus-ring'

/** Quiet icon button: muted glyph, foreground wash on hover. No size. */
export const QUIET_ICON_BUTTON_CLASS = `inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground ${FOCUS_RING_CLASS}`

/** 28px panel-header icon button. */
export const PANEL_ICON_BUTTON_CLASS = `${QUIET_ICON_BUTTON_CLASS} size-7`

/** 40px panel header: `.label-panel` at the start, icon buttons at the end. */
export const PANEL_HEADER_CLASS = 'flex h-10 shrink-0 items-center justify-between pl-4 pr-1.5'

/** Panel text field: card fill, 3:1 field edge, neutral focus border. */
export const PANEL_FIELD_CLASS = `rounded-lg border border-field-border bg-card text-xs pointer-coarse:text-base text-foreground transition-colors duration-150 ease-out placeholder:text-muted-foreground ${FIELD_FOCUS_CLASS}`

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
