import { Bug, Clipboard, Download, FileText, FolderOpen } from '@/components/icons'
import { rowId } from '@/components/settings/row-id'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { SettingsRow } from '@/components/settings/SettingsRow'
import { Button } from '@/components/ui/button'
import { logApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useReportBugStore } from '@/stores/report-bug-store'
import { APP_VERSION } from './updates-section'

function ActionRow({
  label,
  description,
  action,
  actionLabel,
  icon,
  onClick
}: {
  label: string
  description: string
  action: string
  actionLabel: string
  icon: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <SettingsRow label={label} description={description} layout="inline">
      <Button type="button" size="xs" variant="outline" onClick={onClick} aria-label={actionLabel}>
        {icon}
        {action}
      </Button>
    </SettingsRow>
  )
}

export function DiagnosticsSection(): React.JSX.Element {
  // Desktop-only actions (issue #843): the log folder and file exports are
  // hidden on web (host filesystem and native dialogs are unreachable from the
  // browser). Copy works over the web transport, so it stays.
  const isDesktop = isTauriContext()

  return (
    <SettingsSection id="diagnostics">
      <SettingsGroup title="Application log">
        <SettingsCard>
          <ActionRow
            label="Copy log"
            description="Copy the log text to the clipboard."
            action="Copy"
            actionLabel="Copy log contents"
            icon={<Clipboard size={13} />}
            onClick={() => void logApi.copyLogContents()}
          />
          {isDesktop && (
            <>
              <ActionRow
                label="Export log file"
                description="Save a copy of the log where you choose."
                action="Export…"
                actionLabel="Export log file…"
                icon={<FileText size={13} />}
                onClick={() => void logApi.exportLogFile()}
              />
              <ActionRow
                label="Export to Downloads"
                description="Save a copy of the log to your Downloads folder."
                action="Export"
                actionLabel="Export log to Downloads"
                icon={<Download size={13} />}
                onClick={() => void logApi.exportLogToDefault()}
              />
              <ActionRow
                label="Log folder"
                description="Open the folder that holds the Termul logs."
                action="Show folder"
                actionLabel="Show log folder"
                icon={<FolderOpen size={13} />}
                onClick={() => void logApi.revealLogDir()}
              />
            </>
          )}
          {/* Report a Bug (spec-bug-report-dialog): the same dialog every
              other entry point opens — works on desktop and web. */}
          <ActionRow
            label="Report a bug"
            description="File an issue with a redacted diagnostics bundle."
            action="Report"
            actionLabel="Report a bug"
            icon={<Bug size={13} />}
            onClick={() => useReportBugStore.getState().openReport()}
          />
        </SettingsCard>
        {!isDesktop && (
          <SettingsNotice>
            Logs live on the server host. Export and the log folder are available in the desktop
            app.
          </SettingsNotice>
        )}
      </SettingsGroup>
      {!isDesktop && (
        <SettingsGroup title="Server version">
          <SettingsCard>
            <SettingsRow
              id={rowId('server-version')}
              label={`termul-server ${APP_VERSION}`}
              description="The web client is served by the termul-server and updates together with it. Reload the page after the server updates."
            />
          </SettingsCard>
        </SettingsGroup>
      )}
    </SettingsSection>
  )
}
