/**
 * Shared geometry of the expanded Rail so every row lines up: a 12px row
 * inset (`px-3`, Sidebar V2), one 16px icon box, an 8px gap, then the label.
 * Project rows, group rows and the projects inside a group all use these, so
 * their leading icons share one left column and their labels one x.
 */

/** Horizontal inset and icon-to-label gap of a Rail row. */
export const RAIL_ROW_INSET_CLASS = 'gap-2 px-3'

/** The one icon box (16px) every Rail row puts its leading glyph in. */
export const RAIL_ICON_BOX_CLASS = 'inline-flex size-4 shrink-0 items-center justify-center'

/** Width of the collapsed Rail (`w-12`). */
export const COLLAPSED_WIDTH = 48

/** Gap between the Rail and the Side panel (`pl-2` on the shell row in `ShellFrame`). */
export const SHELL_GAP = 8

/**
 * Collapsed Rail hover panels (Sidebar V2) open 4px right of the Rail edge
 * (x = 52). A Rail row spans x = 8..40 (the 8px list inset), so the panel
 * sits 12px from its trigger row.
 */
export const RAIL_HOVER_PANEL_SIDE_OFFSET = 12

/** Inner padding of a hover panel (`p-1`): its first row starts 4px down. */
export const RAIL_HOVER_PANEL_PADDING = 4

/** Height of a project row (`h-7.5`) and the 1px gap under it. */
export const RAIL_PROJECT_ROW_HEIGHT = 30
export const RAIL_ROW_GAP = 1

/** Hover intent delay of every Rail tooltip and hover panel. */
export const RAIL_HOVER_OPEN_DELAY = 400
