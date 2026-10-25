export { INACTIVE_TAB_PANE_CLASS } from '@/components/workspace/inactive-pane-classes'

/**
 * GPUIX rebuilds and lays out its whole element tree every frame, so a chat
 * that is only invisible still costs a full layout per frame: each streaming
 * chat added about a fifth of a core on the UI thread, and four saturated
 * it. Taken out of layout, eight chats cost what one does. A chat scrolled
 * away from the tail comes back mid-transcript, as it does when only hidden.
 */
export const INACTIVE_CHAT_PANE_CLASS = 'w-full h-full absolute inset-0 hidden pointer-events-none'
