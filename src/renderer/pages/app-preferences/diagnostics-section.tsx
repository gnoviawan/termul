import { Clipboard, Download, FileText, FolderOpen } from '@/components/icons'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { logApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'

export function DiagnosticsSection(): React.JSX.Element {
  return (
    <SettingsSection id="diagnostics">
      <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
        <div className="w-full pt-1 md:w-1/3">
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-primary" />
            <h2 className="text-lg font-medium text-foreground">Diagnostics & Logs</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Export or copy application logs to troubleshoot issues.
          </p>
        </div>
        <div className="w-full space-y-4 md:w-full md:w-2/3">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => void logApi.revealLogDir()}
              disabled={!isTauriContext()}
              title={isTauriContext() ? undefined : 'Revealing the log folder is desktop-only'}
              className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:active:scale-100"
            >
              <FolderOpen size={16} className="text-muted-foreground" />
              <div className="text-left">
                <div>Reveal Log Folder</div>
                <div className="text-3xs text-muted-foreground font-normal">
                  {isTauriContext()
                    ? 'Open in file explorer'
                    : 'Desktop only — the log folder lives on the host.'}
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => void logApi.exportLogFile()}
              disabled={!isTauriContext()}
              title={isTauriContext() ? undefined : 'Exporting the log file is desktop-only'}
              className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:active:scale-100"
            >
              <FileText size={16} className="text-muted-foreground" />
              <div className="text-left">
                <div>Export Log File...</div>
                <div className="text-3xs text-muted-foreground font-normal">
                  {isTauriContext()
                    ? 'Save to a custom location'
                    : 'Desktop only — file dialogs are unavailable in the browser.'}
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => void logApi.copyLogContents()}
              className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm"
            >
              <Clipboard size={16} className="text-muted-foreground" />
              <div className="text-left">
                <div>Copy Log Contents</div>
                <div className="text-3xs text-muted-foreground font-normal">
                  Copy logs to clipboard
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => void logApi.exportLogToDefault()}
              disabled={!isTauriContext()}
              title={isTauriContext() ? undefined : 'Exporting to Downloads is desktop-only'}
              className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:active:scale-100"
            >
              <Download size={16} className="text-muted-foreground" />
              <div className="text-left">
                <div>Export to Default Directory</div>
                <div className="text-3xs text-muted-foreground font-normal">
                  {isTauriContext()
                    ? 'Save directly to Downloads'
                    : 'Desktop only — the host file system is unreachable from the browser.'}
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}
