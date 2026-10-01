/**
 * Launcher→chat handoff timing, shared between AgentLauncher (inner exit
 * choreography) and PaneContent (the AnimatePresence keep-alive wrapper).
 *
 * Two exit modes, chosen inside AgentLauncher at the exiting commit:
 * - Launch (a chat tab just appeared in the pane): the hero dissolves upward
 *   while the composer card morphs — a measured FLIP onto the real
 *   ChatInputBar card — then the launcher's own delayed root fade crossfades
 *   the dove card into the live composer.
 * - Dismiss (Escape/close, or a non-chat tab took over the pane): no dive —
 *   the launcher fades in place.
 */

/** Composer morph duration — the transform slide+scale to the docked card. */
export const LAUNCHER_DOCK_SLIDE_MS = 340

/**
 * Fallback dock target when the real chat composer can't be measured yet
 * (lazy chunk still loading), measured from the pane bottom: ChatInputBar's
 * `pb-6` gutter (24px) + its context strip's ~24px overhang below the card.
 */
export const LAUNCHER_DOCK_BOTTOM_PX = 48

/** Root fade waits for the morph to nearly land before crossfading. */
export const LAUNCHER_EXIT_FADE_DELAY_MS = 300
export const LAUNCHER_EXIT_FADE_MS = 160

/**
 * Presence keep-alive window: long enough for the morph (340) to land and
 * the delayed root fade (300+160) to finish, rounded up.
 */
export const LAUNCHER_EXIT_WINDOW_MS = 520

/** In-place dismiss (Escape/close with no new chat): the close is quick — 150ms token. */
export const LAUNCHER_DISMISS_MS = 150

/** Overlay backdrop fade during the morph — gradually reveals the chat. */
export const LAUNCHER_BACKDROP_REVEAL_MS = 300

/** Reduced-motion exit: no morph, just a quick uniform fade. */
export const LAUNCHER_EXIT_REDUCED_MS = 150
