import type { ProjectChatLiveState } from '@/components/sidebar/project-chat-row'

/**
 * Fill of the collapsed Rail status dot per live state (Sidebar V2):
 * needs-you warning, running primary, new activity foreground; idle has none.
 */
export const RAIL_CHAT_STATUS_DOT_CLASS: Record<ProjectChatLiveState, string | null> = {
  'needs-you': 'bg-warning',
  running: 'bg-primary',
  done: 'bg-foreground',
  idle: null
}
