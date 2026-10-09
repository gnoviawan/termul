import { toast } from 'sonner'
import { confirm } from '@/lib/tauri-dialog'
import { hasActiveTerminalSessions } from '@/lib/tauri-safe-update'
import { updaterStore } from '@/stores/updater-store'

/**
 * Ask the user to confirm, then install the downloaded update and restart.
 * Shared by the "Update ready" toast and the sidebar "Restart to update"
 * chip. Install failures surface as an error toast; nothing throws.
 */
export async function confirmInstallAndRestart(version: string | null): Promise<void> {
  try {
    const target = version ? `version ${version}` : 'the new version'
    const confirmed = await confirm(
      hasActiveTerminalSessions()
        ? `Termul will install ${target} and restart. Your running terminal sessions will be closed. Continue?`
        : `Termul will install ${target} and restart now. Continue?`,
      {
        title: 'Install update',
        kind: 'warning',
        okLabel: 'Install & Restart',
        cancelLabel: 'Not now'
      }
    )
    if (!confirmed) return

    await updaterStore.getState().installAndRestart()
    const { downloaded, error: installError } = updaterStore.getState()
    // installAndRestart returns without writing error when the package is
    // gone (for example the user cleared it while this dialog was open).
    // A stale error from an earlier attempt must not replace that report.
    if (!downloaded) {
      toast.error('Update install failed', {
        description: 'The update is no longer ready to install.'
      })
      return
    }
    if (installError) {
      toast.error('Update install failed', { description: installError })
    }
  } catch (error) {
    toast.error('Update install failed', {
      description: error instanceof Error ? error.message : 'Unexpected error during install'
    })
  }
}
