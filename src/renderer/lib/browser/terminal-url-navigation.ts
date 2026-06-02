import { openerApi } from '@/lib/api'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export const TERMINAL_DEDICATED_BROWSER_TAB_ID = 'terminal-link-browser'

function createTerminalBrowserTabId(): string {
  return `${TERMINAL_DEDICATED_BROWSER_TAB_ID}-${crypto.randomUUID()}`
}

export async function openTerminalUrlInDedicatedBrowser(url: string): Promise<void> {
  const targetTabId = createTerminalBrowserTabId()

  useBrowserSessionStore.getState().ensureTab(targetTabId, url)
  useWorkspaceStore.getState().addBrowserTab(targetTabId)
}

export async function openTerminalUrl(url: string): Promise<void> {
  const { terminalUrlOpenMode } = useAppSettingsStore.getState().settings

  if (terminalUrlOpenMode === 'termul') {
    await openTerminalUrlInDedicatedBrowser(url)
    return
  }

  const result = await openerApi.openUrlWithSystemBrowser(url)
  if (!result.success) {
    throw new Error(result.error || 'Failed to open URL in system browser')
  }
}
