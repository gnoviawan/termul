/**
 * Launcher→chat handoff timing, shared between AgentLauncher (inner exit
 * choreography) and PaneContent (the AnimatePresence keep-alive wrapper).
 *
 * The launcher unmounts the moment its chat tab appears, which reads as a
 * hard cut. Instead, the presence boundary keeps it mounted: the hero
 * dissolves upward while the composer dives to where ChatInputBar docks,
 * then the wrapper's delayed fade crossfades the dove composer into the
 * real one.
 */

/** Composer dive duration — the transform slide to the dock position. */
export const LAUNCHER_DOCK_SLIDE_MS = 340

/**
 * Dock target for the composer card's bottom edge, measured from the pane
 * bottom: ChatInputBar's `pb-6` gutter (24px) + its context strip's ~24px
 * overhang below the card.
 */
export const LAUNCHER_DOCK_BOTTOM_PX = 48

/** Wrapper fade waits for the dive to nearly land before crossfading. */
export const LAUNCHER_EXIT_FADE_DELAY_MS = 300
export const LAUNCHER_EXIT_FADE_MS = 160

/** Reduced-motion exit: no dive, just a quick uniform fade. */
export const LAUNCHER_EXIT_REDUCED_MS = 150
