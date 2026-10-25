/** Inactive tabs stay mounted but must not intercept clicks on the active tab beneath. */
export const INACTIVE_TAB_PANE_CLASS =
  'w-full h-full absolute inset-0 invisible pointer-events-none'

/**
 * An inactive chat tab keeps its layout box, so the transcript's virtualizer
 * keeps its scroll position. The GPUIX client overrides this module.
 */
export const INACTIVE_CHAT_PANE_CLASS = INACTIVE_TAB_PANE_CLASS
