import { AlertCircle, CheckCircle2, Download } from '@/components/icons'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { Button } from '@/components/ui/button'
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
  updateError: string | null
  updateChannel: UpdateChannel
  checkForUpdates: () => void
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
  updateError,
  updateChannel,
  checkForUpdates,
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
                          'flex flex-col items-start gap-0.5 px-3 py-2.5 border rounded-lg text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                          active
                            ? 'bg-primary/10 border-primary'
                            : 'bg-secondary/30 border-border hover:bg-secondary/60'
                        )}
                      >
                        <span
                          className={cn(
                            'text-sm font-medium',
                            active ? 'text-primary' : 'text-foreground'
                          )}
                        >
                          {option.label}
                        </span>
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
                        ? 'Nightly builds come from the latest commit and may be unstable. Update downloads, installs, and restarts Termul.'
                        : 'Insider builds may be unfinished. Update downloads, installs, and restarts Termul.'}
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
              <div className="border rounded-md px-4 py-3 flex items-center gap-3 bg-success/10 border-success/20">
                <CheckCircle2 size={18} className="flex-shrink-0 text-success" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-foreground">
                    Version {version} is available!
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {isAurUpdater
                      ? 'Update through AUR with: yay -S termul-manager'
                      : 'Choose Update in the dialog. Termul downloads, installs, and restarts.'}
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
            <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-md px-4 py-3">
              <div className="flex-1">
                <div className="text-sm text-foreground">Automatically check for updates</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  When enabled, the app will periodically check for new versions
                </div>
              </div>
              <button
                onClick={() => handleAutoUpdateToggle(!autoUpdateEnabled)}
                className={cn(
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
                  autoUpdateEnabled ? 'bg-primary-fill' : 'bg-input'
                )}
              >
                <span
                  className={cn(
                    'inline-block h-4 w-4 transform rounded-full bg-primary-foreground transition-transform',
                    autoUpdateEnabled ? 'translate-x-6' : 'translate-x-1'
                  )}
                />
              </button>
            </div>
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}
