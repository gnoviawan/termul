import { AlertCircle, CheckCircle2, Download, ExternalLink } from '@/components/icons'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsSwitchRow } from '@/components/settings/SettingsSwitchRow'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { isTauriContext } from '@/lib/tauri-runtime'
import type { UpdateChannel } from '@/lib/tauri-updater-api'
import { cn } from '@/lib/utils'

interface UpdatesSectionProps {
  isAurUpdater: boolean
  isChecking: boolean
  updateAvailable: boolean
  version: string | null
  lastChecked: Date | null
  autoUpdateEnabled: boolean
  skippedVersion: string | null
  updateError: string | null
  isManualUpdateMode: boolean
  updateChannel: UpdateChannel
  checkForUpdates: () => void
  installAndRestart: () => void
  handleAutoUpdateToggle: (enabled: boolean) => void
  setUpdateChannel: (channel: UpdateChannel) => void
}

export function UpdatesSection({
  isAurUpdater,
  isChecking,
  updateAvailable,
  version,
  lastChecked,
  autoUpdateEnabled,
  skippedVersion,
  updateError,
  isManualUpdateMode,
  updateChannel,
  checkForUpdates,
  installAndRestart,
  handleAutoUpdateToggle,
  setUpdateChannel
}: UpdatesSectionProps): React.JSX.Element {
  const formatLastChecked = (date: Date | null): string => {
    if (!date) return 'Never'
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date)
  }

  // Web (#843): the desktop updater is a desktop-only surface. Hide the
  // whole category's controls and show the web client's actual version
  // source instead — the bundle served by (and updated with) the server.
  if (!isTauriContext()) {
    return (
      <SettingsSection id="updates">
        <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
          <div className="w-full pt-1 md:w-1/3">
            <div className="flex items-center gap-2">
              <Download size={18} className="text-primary" />
              <h2 className="text-lg font-medium text-foreground">Updates</h2>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Server version and update policy for the web client.
            </p>
          </div>
          <div className="w-full space-y-4 md:w-full md:w-2/3">
            <div>
              <label className="block text-sm font-medium text-secondary-foreground mb-2">
                Server Version
              </label>
              <div className="bg-secondary/30 border border-border rounded-md px-4 py-3">
                <span className="text-sm font-mono text-foreground">
                  v{import.meta.env.PACKAGE_VERSION || '0.1.0'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                The web client is served by the termul-server and updates together with it — reload
                the page after the server updates to pick up the new bundle. Desktop-only update
                controls (channels, auto-update, install) are hidden here.
              </p>
            </div>
          </div>
        </div>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection id="updates">
      <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
        <div className="w-full pt-1 md:w-1/3">
          <div className="flex items-center gap-2">
            <Download size={18} className="text-primary" />
            <h2 className="text-lg font-medium text-foreground">Updates</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Manage application updates and version information.
          </p>
        </div>
        <div className="w-full space-y-4 md:w-full md:w-2/3">
          {/* Current Version */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Current Version
            </label>
            <div className="bg-secondary/30 border border-border rounded-md px-4 py-3">
              <span className="text-sm font-mono text-foreground">
                v{import.meta.env.PACKAGE_VERSION || '0.1.0'}
              </span>
            </div>
          </div>

          {/* Release Channel */}
          {!isAurUpdater && (
            <div>
              <label className="block text-sm font-medium text-secondary-foreground mb-2">
                Release Channel
              </label>
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {(
                    [
                      {
                        id: 'stable',
                        label: 'Stable',
                        description: 'Production releases. Most reliable.'
                      },
                      {
                        id: 'insider',
                        label: 'Insider',
                        description: 'Release candidates (rc) before stable.'
                      },
                      {
                        id: 'nightly',
                        label: 'Nightly',
                        description: 'Automated main-branch builds.'
                      }
                    ] as const
                  ).map((option) => {
                    const active = updateChannel === option.id
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setUpdateChannel(option.id)}
                        aria-pressed={active}
                        disabled={isChecking}
                        className={cn(
                          'flex flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2.5 text-left transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50',
                          FOCUS_RING_CLASS,
                          active
                            ? 'keycap text-foreground'
                            : 'text-secondary-foreground hover:bg-foreground/[0.03]'
                        )}
                      >
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-3xs text-muted-foreground font-normal">
                          {option.description}
                        </span>
                      </button>
                    )
                  })}
                </div>
                {updateChannel !== 'stable' && (
                  <div className="flex items-start gap-2 bg-warning/10 border border-warning/20 rounded-md px-3 py-2.5">
                    <AlertCircle size={14} className="text-warning flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-foreground">
                      {updateChannel === 'nightly'
                        ? 'Nightly builds are automated from the latest commit and may be unstable. Updates are offered as a manual download from the nightly release page.'
                        : 'Insider release candidates may be unfinished. Updates are offered as a manual download from the insider release page.'}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Update Status */}
          {updateAvailable && version && (
            <div>
              <label className="block text-sm font-medium text-secondary-foreground mb-2">
                Update Available
              </label>
              <div
                className={cn(
                  'border rounded-md px-4 py-3 flex items-center gap-3',
                  isManualUpdateMode
                    ? 'bg-warning/10 border-warning/20'
                    : 'bg-success/10 border-success/20'
                )}
              >
                <CheckCircle2
                  size={18}
                  className={cn(
                    'flex-shrink-0',
                    isManualUpdateMode ? 'text-warning' : 'text-success'
                  )}
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-foreground">
                    Version {version} is available!
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {isAurUpdater
                      ? 'Update through AUR with: yay -S termul-manager'
                      : isManualUpdateMode
                        ? 'Automatic update is unavailable. Please download and install the latest version manually.'
                        : 'A new version is ready to download.'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Update Error */}
          {updateError && (
            <div>
              <label className="block text-sm font-medium text-secondary-foreground mb-2">
                Update Error
              </label>
              <div className="bg-destructive/10 border border-destructive/20 rounded-md px-4 py-3 flex items-center gap-3">
                <AlertCircle size={18} className="text-destructive flex-shrink-0" />
                <div className="flex-1">
                  <div className="text-sm text-foreground">{updateError}</div>
                </div>
              </div>
            </div>
          )}

          {/* Check for Updates Button */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Check for Updates
            </label>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={checkForUpdates} disabled={isChecking}>
                <Download />
                {isChecking ? 'Checking for updates...' : 'Check for Updates'}
              </Button>
              {updateAvailable && isManualUpdateMode && (
                <button
                  onClick={installAndRestart}
                  className="flex h-9 items-center gap-2 rounded-lg border border-warning bg-warning px-3 text-sm text-warning-foreground transition-colors hover:bg-warning/90"
                >
                  <ExternalLink size={16} />
                  Open Download Page
                </button>
              )}
            </div>
            {lastChecked && (
              <p className="text-xs text-muted-foreground mt-1">
                Last checked: {formatLastChecked(lastChecked)}
              </p>
            )}
          </div>

          {/* Auto-update Toggle */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Auto-update
            </label>
            <SettingsSwitchRow
              label="Automatically check for updates"
              description="When enabled, the app will periodically check for new versions"
              checked={autoUpdateEnabled}
              onToggle={handleAutoUpdateToggle}
            />
          </div>

          {/* Skipped Version */}
          {skippedVersion && (
            <div>
              <label className="block text-sm font-medium text-secondary-foreground mb-2">
                Skipped Version
              </label>
              <div className="bg-secondary/30 border border-border rounded-md px-4 py-3">
                <div className="text-sm text-foreground">
                  You are currently skipping version{' '}
                  <span className="font-mono">{skippedVersion}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  This version will not be offered again until a newer version is available.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  )
}
