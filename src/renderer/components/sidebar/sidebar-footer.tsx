import { useEffect, useState } from 'react'
import { confirmInstallAndRestart } from '@/lib/confirm-install-update'
import { getCurrentAppVersion } from '@/lib/tauri-release-notes'
import { useUpdateDownloaded, useUpdateVersion } from '@/stores/updater-store'

/** Build-time version; shown until the runtime version helper resolves. */
const BUILD_VERSION = import.meta.env.PACKAGE_VERSION || ''

/**
 * Projects panel footer: running app version, plus a "Restart to update"
 * chip when the updater store has a downloaded update. The chip runs the
 * same {@link confirmInstallAndRestart} flow as the "Update ready" toast.
 */
export function SidebarFooter(): React.JSX.Element {
  const [version, setVersion] = useState(BUILD_VERSION)
  const updateDownloaded = useUpdateDownloaded()
  const updateVersion = useUpdateVersion()

  useEffect(() => {
    let cancelled = false
    getCurrentAppVersion()
      .then((v) => {
        if (!cancelled && v && v !== '0.0.0') setVersion(v)
      })
      .catch(() => {
        // Keep the build-time version when the runtime lookup fails.
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      className="flex h-9 shrink-0 items-center justify-between border-t border-border pl-4 pr-2"
      data-testid="sidebar-footer"
    >
      <span className="text-2xs tabular-nums text-muted-foreground">
        Termul{version ? ` v${version}` : ''}
      </span>
      {updateDownloaded && (
        <button
          type="button"
          onClick={() => void confirmInstallAndRestart(updateVersion)}
          className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-2xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={updateVersion ? `Install v${updateVersion} and restart` : 'Install and restart'}
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
          Restart to update
        </button>
      )}
    </div>
  )
}
