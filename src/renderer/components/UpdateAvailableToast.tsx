import { Clock, Download, Terminal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { i18n } from '@/i18n'
import { confirm } from '@/lib/tauri-dialog'
import { hasActiveTerminalSessions } from '@/lib/tauri-safe-update'
import { isAurUpdateMode } from '@/lib/tauri-updater-api'
import {
  updaterStore,
  useDownloadProgress,
  useIsDownloading,
  useUpdateDownloaded,
  useUpdaterActions,
  useUpdaterState,
  useUpdateVersion
} from '@/stores/updater-store'

// Local storage keys
const UPDATE_REMINDER_KEY = 'update-reminder-timestamp'

/**
 * Check if the user has asked to be reminded tomorrow
 */
function shouldShowReminder(): boolean {
  const reminderTimestamp = localStorage.getItem(UPDATE_REMINDER_KEY)
  if (!reminderTimestamp) return true

  const reminderDate = new Date(reminderTimestamp)
  const now = new Date()
  const oneDayInMs = 24 * 60 * 60 * 1000

  return now.getTime() - reminderDate.getTime() >= oneDayInMs
}

/**
 * Set reminder for tomorrow
 */
function setReminderForTomorrow(): void {
  const now = new Date()
  localStorage.setItem(UPDATE_REMINDER_KEY, now.toISOString())
}

/**
 * Show a toast notification for available update
 */
export function showUpdateToast(version: string, releaseNotes?: string): void {
  const isAur = isAurUpdateMode()
  const channel = updaterStore.getState().updateChannel
  const channelPrefix =
    channel === 'stable' ? '' : `${i18n.t(`updates.channels.${channel}`, { ns: 'shell' })} `

  toast.success(i18n.t('updates.available', { ns: 'shell', channel: channelPrefix, version }), {
    duration: 30000,
    description: releaseNotes
      ? i18n.t('updates.whatsNew', {
          ns: 'shell',
          notes: `${releaseNotes.slice(0, 100)}${releaseNotes.length > 100 ? '...' : ''}`
        })
      : isAur
        ? i18n.t('updates.aurAvailable', { ns: 'shell' })
        : channel !== 'stable'
          ? i18n.t('updates.manualChannel', {
              ns: 'shell',
              channel
            })
          : i18n.t('updates.downloadAvailable', { ns: 'shell' }),
    action: {
      label: (
        <div className="flex items-center gap-2">
          {isAur ? <Terminal size={14} /> : <Download size={14} />}
          <span>
            {isAur
              ? i18n.t('updates.useYay', { ns: 'shell' })
              : channel !== 'stable'
                ? i18n.t('updates.downloadPage', { ns: 'shell' })
                : i18n.t('updates.download', { ns: 'shell' })}
          </span>
        </div>
      ),
      onClick: async () => {
        if (isAur) {
          toast.info(i18n.t('updates.runInTerminal', { ns: 'shell' }), {
            description: 'yay -S termul-manager'
          })
          return
        }

        const { downloadUpdate } = updaterStore.getState()
        try {
          await downloadUpdate()
          const downloadError = updaterStore.getState().error
          if (downloadError) {
            toast.error(i18n.t('updates.downloadFailed', { ns: 'shell' }), {
              description: downloadError
            })
          }
        } catch (error) {
          toast.error(i18n.t('updates.downloadFailed', { ns: 'shell' }), {
            description:
              error instanceof Error
                ? error.message
                : i18n.t('updates.unexpectedDownload', { ns: 'shell' })
          })
        }
      }
    },
    cancel: {
      label: (
        <div className="flex items-center gap-2">
          <Clock size={14} />
          <span>{i18n.t('updates.remind', { ns: 'shell' })}</span>
        </div>
      ),
      onClick: () => {
        setReminderForTomorrow()
      }
    }
  })
}

/**
 * Show a toast notification when update is downloaded
 */
export function showUpdateDownloadedToast(version: string): void {
  toast.success(i18n.t('updates.ready', { ns: 'shell' }), {
    duration: 30000,
    description: i18n.t('updates.downloaded', { ns: 'shell', version }),
    action: {
      label: (
        <div className="flex items-center gap-2">
          <Download size={14} />
          <span>{i18n.t('updates.installRestart', { ns: 'shell' })}</span>
        </div>
      ),
      onClick: async () => {
        try {
          const hasActiveTerminals = hasActiveTerminalSessions()
          const confirmed = await confirm(
            hasActiveTerminals
              ? i18n.t('updates.installWithTerminals', { ns: 'shell', version })
              : i18n.t('updates.installWithoutTerminals', { ns: 'shell', version }),
            {
              title: i18n.t('updates.installTitle', { ns: 'shell' }),
              kind: 'warning',
              okLabel: i18n.t('updates.installRestart', { ns: 'shell' }),
              cancelLabel: i18n.t('updates.notNow', { ns: 'shell' })
            }
          )
          if (!confirmed) return

          const { installAndRestart } = updaterStore.getState()
          await installAndRestart()
          const installError = updaterStore.getState().error
          if (installError) {
            toast.error(i18n.t('updates.installFailed', { ns: 'shell' }), {
              description: installError
            })
          }
        } catch (error) {
          toast.error(i18n.t('updates.installFailed', { ns: 'shell' }), {
            description:
              error instanceof Error
                ? error.message
                : i18n.t('updates.unexpectedInstall', { ns: 'shell' })
          })
        }
      }
    }
  })
}

/**
 * Show a toast notification with download progress
 */
function showDownloadProgressToast(version: string, progress: number): void {
  const progressId = `download-progress-${version}`

  toast.loading(i18n.t('updates.downloading', { ns: 'shell', version }), {
    id: progressId,
    description: i18n.t('updates.complete', {
      ns: 'shell',
      progress: progress.toFixed(0)
    }),
    duration: Infinity
  })
}

/**
 * Dismiss download progress toast
 */
function dismissDownloadProgressToast(version: string): void {
  const progressId = `download-progress-${version}`
  toast.dismiss(progressId)
}

/**
 * Hook to manage update toast notifications
 * Listens to updater state changes and shows appropriate toasts
 */
export function useUpdateToast(): void {
  const { updateAvailable, downloaded, isDownloading, skippedVersion } = useUpdaterState()
  const version = useUpdateVersion()
  const _updateDownloaded = useUpdateDownloaded()
  const downloading = useIsDownloading()
  const downloadProgress = useDownloadProgress()

  // Track if we've already shown a toast for the current update
  const hasShownAvailableToast = useRef(false)
  const hasShownDownloadedToast = useRef(false)

  // Show toast when update becomes available
  useEffect(() => {
    if (
      updateAvailable &&
      version &&
      !downloaded &&
      !hasShownAvailableToast.current &&
      !downloading &&
      shouldShowReminder() &&
      skippedVersion !== version
    ) {
      showUpdateToast(version)
      hasShownAvailableToast.current = true
    }
  }, [updateAvailable, version, downloaded, downloading, skippedVersion])

  // Show toast when update is downloaded and ready to install
  useEffect(() => {
    if (downloaded && version && !hasShownDownloadedToast.current) {
      showUpdateDownloadedToast(version)
      hasShownDownloadedToast.current = true
    }
  }, [downloaded, version])

  // Show download progress
  useEffect(() => {
    if (isDownloading && version) {
      showDownloadProgressToast(version, downloadProgress)

      // Clean up progress toast when download completes or effect re-runs
      return () => {
        dismissDownloadProgressToast(version)
      }
    }
  }, [isDownloading, downloadProgress, version])

  // Reset flags when update state changes
  useEffect(() => {
    if (!updateAvailable) {
      hasShownAvailableToast.current = false
      hasShownDownloadedToast.current = false
    }
  }, [updateAvailable])
}

/**
 * Hook to manually trigger update toasts with options
 */
export function useManualUpdateToast() {
  const { updateAvailable, version, downloaded } = useUpdaterState()
  const { skipVersion } = useUpdaterActions()

  const showAvailable = () => {
    if (version) {
      showUpdateToast(version)
    }
  }

  const showDownloaded = () => {
    if (version) {
      showUpdateDownloadedToast(version)
    }
  }

  const skip = () => {
    if (version) {
      skipVersion(version)
      toast.info(i18n.t('updates.skipped', { ns: 'shell', version }), {
        description: i18n.t('updates.skippedDescription', { ns: 'shell' })
      })
    }
  }

  const remindTomorrow = () => {
    setReminderForTomorrow()
    toast.info(i18n.t('updates.reminderSet', { ns: 'shell' }), {
      description: i18n.t('updates.reminderDescription', { ns: 'shell' })
    })
  }

  return {
    showAvailable,
    showDownloaded,
    skip,
    remindTomorrow,
    canShow: updateAvailable && version !== null,
    isReady: downloaded
  }
}
