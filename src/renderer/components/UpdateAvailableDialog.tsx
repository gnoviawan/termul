import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { isTauriContext } from '@/lib/tauri-runtime'
import { hasActiveTerminalSessions } from '@/lib/tauri-safe-update'
import { isAurUpdateMode, type UpdateChannel } from '@/lib/tauri-updater-api'
import {
  updaterStore,
  useUpdateChannel,
  useUpdaterActions,
  useUpdaterState,
  useUpdateVersion
} from '@/stores/updater-store'

const UPDATE_REMINDER_KEY = 'update-reminder-timestamp'

type DialogPhase = 'offer' | 'confirm' | 'working'

function shouldShowReminder(): boolean {
  const reminderTimestamp = localStorage.getItem(UPDATE_REMINDER_KEY)
  if (!reminderTimestamp) return true

  const reminderDate = new Date(reminderTimestamp)
  const now = new Date()
  const oneDayInMs = 24 * 60 * 60 * 1000
  return now.getTime() - reminderDate.getTime() >= oneDayInMs
}

function setReminderForTomorrow(): void {
  localStorage.setItem(UPDATE_REMINDER_KEY, new Date().toISOString())
}

function channelLabel(channel: UpdateChannel): string {
  if (channel === 'insider') return 'Insider'
  if (channel === 'nightly') return 'Nightly'
  return 'Stable'
}

/**
 * Desktop update dialog. It can open on any screen.
 * Update downloads the signed bundle, installs it, and restarts the app.
 * When terminal sessions are open, one confirm appears before that work starts.
 * AUR builds show the package-manager command. Later is the only dismiss action.
 */
export function UpdateAvailableDialog(): React.JSX.Element | null {
  const isDesktop = isTauriContext()
  const { updateAvailable, isDownloading, error, downloadProgress } = useUpdaterState()
  const version = useUpdateVersion()
  const channel = useUpdateChannel()
  const { downloadUpdate } = useUpdaterActions()
  const [phase, setPhase] = useState<DialogPhase>('offer')
  const [dismissed, setDismissed] = useState(false)
  const isAur = isAurUpdateMode()

  useEffect(() => {
    setPhase(version && channel ? 'offer' : 'offer')
    setDismissed(false)
  }, [version, channel])

  const visible =
    isDesktop &&
    Boolean(version) &&
    (isDownloading || (updateAvailable && shouldShowReminder() && !dismissed))
  const working = phase === 'working' || isDownloading

  useEffect(() => {
    if (!visible || working) return

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (phase === 'confirm') {
        setPhase('offer')
        return
      }
      setReminderForTomorrow()
      setDismissed(true)
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [visible, phase, working])

  if (!visible || !version) return null

  const label = channelLabel(channel)
  const percent = Math.max(0, Math.min(100, Math.round(downloadProgress)))

  const remindLater = (): void => {
    setReminderForTomorrow()
    setDismissed(true)
    setPhase('offer')
  }

  const runUpdate = async (): Promise<void> => {
    setPhase('working')
    await downloadUpdate()
    if (updaterStore.getState().error) {
      setPhase('offer')
    }
  }

  const startUpdate = (): void => {
    if (hasActiveTerminalSessions()) {
      setPhase('confirm')
      return
    }
    void runUpdate()
  }

  const title = phase === 'confirm' ? 'Close terminals and update?' : 'New update available'
  const message = isAur
    ? `Version ${version} is available on the ${label} channel. This build updates with the AUR helper.`
    : phase === 'confirm'
      ? `Termul will close your running terminal sessions, install version ${version}, and restart.`
      : working
        ? `Downloading version ${version}. Termul installs the update and restarts when the download finishes.`
        : `${label} ${version} is ready. Termul will download the update, install it, and restart.`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/60 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-available-title"
        className="w-[420px] overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
      >
        <div className="space-y-3 p-6">
          <h2 id="update-available-title" className="text-sm font-semibold text-foreground">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{message}</p>
          {isAur && (
            <p className="rounded-md bg-secondary px-3 py-2 font-mono text-sm text-foreground">
              yay -S termul-manager
            </p>
          )}
          {working ? (
            <div className="space-y-1">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-2 overflow-hidden rounded-full bg-secondary"
              >
                <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">{percent}% complete</p>
            </div>
          ) : null}
          {error && !working && <p className="text-sm text-destructive">{error}</p>}
        </div>
        {!working && phase === 'offer' ? (
          <div className="flex justify-end gap-2 border-t border-border bg-secondary/50 px-6 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={remindLater}>
              Later
            </Button>
            {!isAur && (
              <Button type="button" size="sm" onClick={startUpdate}>
                Update
              </Button>
            )}
          </div>
        ) : null}
        {!working && phase === 'confirm' ? (
          <div className="flex justify-end gap-2 border-t border-border bg-secondary/50 px-6 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPhase('offer')}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void runUpdate()}>
              Continue
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
