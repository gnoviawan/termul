import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { confirmInstallAndRestart } from '@/lib/confirm-install-update'
import { isTauriContext } from '@/lib/tauri-runtime'
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
 * Sonner lays out icon, text and buttons in one row; two buttons leave the
 * text about 30px wide. Wrap so the text keeps the full width (the basis
 * leaves room for the 16px icon and its margins) and the buttons take their
 * own row, and let long nightly versions break. Sonner gives every button
 * `margin-left: auto`, so the first one aligns the row right.
 */
const UPDATE_TOAST_CLASS_NAMES = {
  toast: 'flex-wrap',
  content: 'min-w-0 grow basis-[calc(100%-28px)]',
  description: '[overflow-wrap:anywhere]'
}

/** With a cancel button, the action sits 8px after it instead of taking the other auto margin. */
const UPDATE_TOAST_TWO_BUTTON_CLASS_NAMES = {
  ...UPDATE_TOAST_CLASS_NAMES,
  actionButton: 'ml-2!'
}

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
  // Copy follows the update mode, not the channel: a signed nightly installs
  // in the app, while a fallback (any channel) opens the release page.
  const { updateChannel: channel, isManualUpdateMode: isManual } = updaterStore.getState()
  const title =
    channel === 'insider'
      ? 'Insider update available'
      : channel === 'nightly'
        ? 'Nightly update available'
        : 'Update available'

  toast.success(title, {
    duration: 30000,
    classNames: UPDATE_TOAST_TWO_BUTTON_CLASS_NAMES,
    description: releaseNotes
      ? `Version ${version}. What's new: ${releaseNotes.slice(0, 100)}${releaseNotes.length > 100 ? '…' : ''}`
      : isAur
        ? `Version ${version} is available. Update with yay.`
        : isManual
          ? `Version ${version}. Open the download page to install it manually.`
          : `Version ${version} is ready to download.`,
    action: {
      label: isAur ? 'Use yay' : isManual ? 'Open download page' : 'Download',
      onClick: async () => {
        if (isAur) {
          toast.info('Run in terminal', {
            description: 'yay -S termul-manager'
          })
          return
        }

        const { downloadUpdate } = updaterStore.getState()
        try {
          await downloadUpdate()
          const downloadError = updaterStore.getState().error
          if (downloadError) {
            toast.error('Update download failed', {
              description: downloadError
            })
          }
        } catch (error) {
          toast.error('Update download failed', {
            description: error instanceof Error ? error.message : 'Unexpected error during download'
          })
        }
      }
    },
    cancel: {
      label: 'Remind me tomorrow',
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
  toast.success('Update ready to install', {
    duration: 30000,
    classNames: UPDATE_TOAST_CLASS_NAMES,
    description: `Version ${version} is downloaded. Termul restarts to install it, and running terminal sessions close.`,
    action: {
      label: 'Install and restart',
      onClick: () => confirmInstallAndRestart(version)
    }
  })
}

/**
 * Show a toast notification with download progress
 */
function showDownloadProgressToast(version: string, progress: number): void {
  const progressId = `download-progress-${version}`

  toast.loading(`Downloading update ${version}...`, {
    id: progressId,
    description: `${progress.toFixed(0)}% complete`,
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
 *
 * Desktop-only (issue #843): the web client is updated together with the
 * server, so update-available/downloaded/progress toasts never show there.
 * The hook still subscribes to store state (stable hook order for both
 * roots) but every toast effect no-ops on web.
 */
export function useUpdateToast(): void {
  const isDesktop = isTauriContext()
  const { updateAvailable, downloaded, isDownloading, skippedVersion, isManualUpdateMode } =
    useUpdaterState()
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
      isDesktop &&
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
  }, [isDesktop, updateAvailable, version, downloaded, downloading, skippedVersion])

  // Show toast when update is downloaded and ready to install
  useEffect(() => {
    if (isDesktop && downloaded && version && !hasShownDownloadedToast.current) {
      showUpdateDownloadedToast(version)
      hasShownDownloadedToast.current = true
    }
  }, [isDesktop, downloaded, version])

  // Show download progress. A manual update only opens the release page:
  // nothing reports progress, and the open finishes so fast that sonner can
  // apply the dismiss before its deferred create, leaving a stuck 0% toast.
  useEffect(() => {
    if (isDesktop && isDownloading && version && !isManualUpdateMode) {
      showDownloadProgressToast(version, downloadProgress)

      // Clean up progress toast when download completes or effect re-runs
      return () => {
        dismissDownloadProgressToast(version)
      }
    }
  }, [isDesktop, isDownloading, downloadProgress, version, isManualUpdateMode])

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
      toast.info(`Skipped version ${version}`, {
        description: 'You will not be notified about this version again.'
      })
    }
  }

  const remindTomorrow = () => {
    setReminderForTomorrow()
    toast.info('Reminder set', {
      description: 'We will remind you about the update tomorrow.'
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
