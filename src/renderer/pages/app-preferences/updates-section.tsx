import { ExternalLink, RefreshCw, RotateCcw } from '@/components/icons'
import { rowId } from '@/components/settings/row-id'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { isTauriContext } from '@/lib/tauri-runtime'
import type { UpdateChannel } from '@/lib/tauri-updater-api'

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

const CHANNELS: Array<{ value: UpdateChannel; label: string; description: string }> = [
  { value: 'stable', label: 'Stable', description: 'Production releases. Most reliable.' },
  { value: 'insider', label: 'Insider', description: 'Release candidates (rc) before stable.' },
  { value: 'nightly', label: 'Nightly', description: 'Automated main-branch builds.' }
]

const formatLastChecked = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)

export const APP_VERSION = `v${import.meta.env.PACKAGE_VERSION || '0.1.0'}`

/**
 * Desktop-only page (issue #843). On web the page is hidden and the server
 * version note lives on the Logs page.
 */
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
}: UpdatesSectionProps): React.JSX.Element | null {
  if (!isTauriContext()) return null

  const channel = CHANNELS.find((option) => option.value === updateChannel) ?? CHANNELS[0]
  const versionDescription = [
    isAurUpdater ? 'Installed from the AUR' : `${channel.label} channel`,
    isChecking
      ? 'checking now'
      : lastChecked
        ? `last checked ${formatLastChecked(lastChecked)}`
        : 'not checked yet'
  ].join(' · ')

  return (
    <SettingsSection id="updates">
      <SettingsGroup title="Version">
        {updateAvailable && version && (
          <SettingsNotice
            tone={isManualUpdateMode ? 'warning' : 'success'}
            action={
              !isAurUpdater && isManualUpdateMode ? (
                <Button type="button" size="xs" onClick={installAndRestart}>
                  <ExternalLink size={13} />
                  Open download page
                </Button>
              ) : null
            }
          >
            <span className="font-medium text-foreground">Version {version} is available.</span>{' '}
            {isAurUpdater
              ? 'Update through the AUR with: yay -S termul-manager'
              : isManualUpdateMode
                ? 'Automatic update is not available. Download and install it from the release page.'
                : 'A new version is ready to download.'}
          </SettingsNotice>
        )}
        {updateError && (
          <SettingsNotice
            tone="danger"
            action={
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={isChecking}
                onClick={checkForUpdates}
              >
                <RotateCcw size={13} />
                Try again
              </Button>
            }
          >
            Termul could not check for updates. Check your connection, then try again.
            <span className="mt-1 block break-words font-mono text-muted-foreground">
              {updateError}
            </span>
          </SettingsNotice>
        )}
        <SettingsCard>
          <SettingsRow
            id={rowId('check-updates')}
            label={`Termul ${APP_VERSION}`}
            description={versionDescription}
            layout="inline"
          >
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={checkForUpdates}
              disabled={isChecking}
            >
              {isChecking ? <Spinner size={13} decorative /> : <RefreshCw size={13} />}
              {isChecking ? 'Checking for updates…' : 'Check for updates'}
            </Button>
          </SettingsRow>
        </SettingsCard>
        {skippedVersion && (
          <SettingsNotice>
            You skipped version <span className="font-mono">{skippedVersion}</span>. Termul offers
            updates again when a newer version is out.
          </SettingsNotice>
        )}
      </SettingsGroup>

      {!isAurUpdater && (
        <SettingsGroup title="Channel">
          <SettingsCard>
            <SettingsRow
              id={rowId('release-channel')}
              htmlFor="release-channel"
              label="Release channel"
              description={`${channel.label}: ${channel.description}`}
            >
              <SettingsSelect
                id="release-channel"
                aria-describedby={settingsDescriptionId('release-channel')}
                options={CHANNELS}
                value={updateChannel}
                disabled={isChecking}
                onValueChange={(value) => setUpdateChannel(value as UpdateChannel)}
              />
            </SettingsRow>
          </SettingsCard>
          {updateChannel !== 'stable' && (
            <SettingsNotice tone="warning">
              {updateChannel === 'nightly'
                ? 'Nightly builds are automated from the latest commit and may be unstable. Updates are offered as a manual download from the nightly release page.'
                : 'Insider release candidates may be unfinished. Updates are offered as a manual download from the insider release page.'}
            </SettingsNotice>
          )}
        </SettingsGroup>
      )}

      <SettingsGroup title="Automatic updates">
        <SettingsCard>
          <SettingsRow
            id={rowId('auto-update')}
            htmlFor="auto-update"
            label="Check for updates automatically"
            description="Termul checks for a new version from time to time."
            layout="inline"
          >
            <Switch
              id="auto-update"
              aria-describedby={settingsDescriptionId('auto-update')}
              checked={autoUpdateEnabled}
              onCheckedChange={handleAutoUpdateToggle}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </SettingsSection>
  )
}
