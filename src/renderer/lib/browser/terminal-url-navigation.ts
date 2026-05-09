import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export const TERMINAL_DEDICATED_BROWSER_TAB_ID = 'terminal-link-browser'

function createTerminalBrowserTabId(): string {
  return `${TERMINAL_DEDICATED_BROWSER_TAB_ID}-${crypto.randomUUID()}`
}

export async function openTerminalUrlInDedicatedBrowser(url: string): Promise<void> {
  // Always open a new browser tab for terminal links.
  const targetTabId = createTerminalBrowserTabId()

  useBrowserSessionStore.getState().ensureTab(targetTabId, url)
  useWorkspaceStore.getState().addBrowserTab(targetTabId)
}
