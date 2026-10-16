/**
 * Shared geometry of the expanded Rail so every row lines up: an 8px row
 * inset (`px-2`), one 16px icon box, an 8px gap, then the label. Search,
 * Canvas, project rows, group rows and the projects inside a group all use
 * these, so their leading icons share one left column and their labels one x.
 */

/** Horizontal inset and icon-to-label gap of a Rail row. */
export const RAIL_ROW_INSET_CLASS = 'gap-2 px-2'

/** The one icon box (16px) every Rail row puts its leading glyph in. */
export const RAIL_ICON_BOX_CLASS = 'inline-flex size-4 shrink-0 items-center justify-center'

/** Width of the collapsed Rail (`w-12`). */
export const COLLAPSED_WIDTH = 48

/** Gap between the Rail and the Side panel (`pl-2` on the shell row in `ShellFrame`). */
export const SHELL_GAP = 8
