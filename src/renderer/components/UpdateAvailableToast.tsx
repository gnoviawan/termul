import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Download, X, Clock } from 'lucide-react'
import {
  updaterStore,
  useUpdaterState,
  useUpdaterActions,
  useUpdateVersion,
  useUpdateDownloaded,
  useIsDownloading,
  useDownloadProgress
} from '@/stores/updater-store'

// Local storage keys
const UPDATE_REMINDER_KEY = 'update-reminder-timestamp'
const SKIPPED_VERSION_KEY = 'skipped-update-version'

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
 * Check if a version was skipped
 */
function isVersionSkipped(version: string): boolean {
  const skippedVersion = localStorage.getItem(SKIPPED_VERSION_KEY)
  return skippedVersion === version
}

/**
 * Skip a version
 */
function skipVersionLocally(version: string): void {
  localStorage.setItem(SKIPPED_VERSION_KEY, version)
}

/**
 * Show a toast notification for available update
 */
export function showUpdateToast(version: string, releaseNotes?: string): void {
  toast.success(`Update available: version ${version}`, {
    duration: 30000,
    description: releaseNotes
      ? `What's new:\n${releaseNotes.slice(0, 100)}${releaseNotes.length > 100 ? '...' : ''}`
      : 'A new version is available for download.',
    action: {
      label: (
        <div className="flex items-center gap-2">
          <Download size={14} />
          <span>Download</span>
        </div>
      ),
      onClick: () => {
        // Trigger download via global store
        const { downloadUpdate } = updaterStore.getState()
        downloadUpdate()
      }
    },
    cancel: {
      label: (
        <div className="flex items-center gap-2">
          <Clock size={14} />
          <span>Remind Me</span>
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
  toast.success(`Update ready to install!`, {
    duration: 30000,
    description: `Version ${version} has been downloaded and is ready to install.`,
    action: {
      label: (
        <div className="flex items-center gap-2">
          <Download size={14} />
          <span>Install & Restart</span>
        </div>
      ),
      onClick: () => {
        const { installAndRestart } = updaterStore.getState()
        installAndRestart()
      }
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
 */
export function useUpdateToast(): void {
  const { updateAvailable, downloaded, isDownloading } = useUpdaterState()
  const version = useUpdateVersion()
  const updateDownloaded = useUpdateDownloaded()
  const downloading = useIsDownloading()
  const downloadProgress = useDownloadProgress()
  const { skipVersion } = useUpdaterActions()

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
      !isVersionSkipped(version)
    ) {
      // Get release notes from store if available
      // Note: We'll need to add releaseNotes to the store state
      showUpdateToast(version)
      hasShownAvailableToast.current = true

      // Reset flag when update is no longer available
      return () => {
        if (!updateAvailable) {
          hasShownAvailableToast.current = false
        }
      }
    }
  }, [updateAvailable, version, downloaded, downloading])

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
      skipVersionLocally(version)
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
