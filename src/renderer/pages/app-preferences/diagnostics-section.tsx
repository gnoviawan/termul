import { Clipboard, Download, FileText, FolderOpen } from '@/components/icons'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { logApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'

export function DiagnosticsSection(): React.JSX.Element {
  // Desktop-only actions (issue #843): Reveal Log Folder / Export Log File /
  // Export to Default Directory are hidden on web (host filesystem and
  // native dialogs are unreachable from the browser) instead of rendered as
  // disabled buttons. Copy Log Contents stays — it works over the web
  // transport (`logApi.copyLogContents` POSTs to the server and copies the
  // returned contents).
  const isDesktop = isTauriContext()

  return (
    <SettingsSection id="diagnostics">
      <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
        <div className="w-full pt-1 md:w-1/3">
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-primary" />
            <h2 className="text-lg font-medium text-foreground">Diagnostics & Logs</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {isDesktop
              ? 'Export or copy application logs to troubleshoot issues.'
              : 'Copy application logs to troubleshoot issues.'}
          </p>
        </div>
        <div className="w-full space-y-4 md:w-full md:w-2/3">
          <div className="grid grid-cols-2 gap-3">
            {isDesktop && (
              <button
                type="button"
                onClick={() => void logApi.revealLogDir()}
                className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm"
              >
                <FolderOpen size={16} className="text-muted-foreground" />
                <div className="text-left">
                  <div>Reveal Log Folder</div>
                  <div className="text-3xs text-muted-foreground font-normal">
                    Open in file explorer
                  </div>
                </div>
              </button>
            )}

            {isDesktop && (
              <button
                type="button"
                onClick={() => void logApi.exportLogFile()}
                className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm"
              >
                <FileText size={16} className="text-muted-foreground" />
                <div className="text-left">
                  <div>Export Log File...</div>
                  <div className="text-3xs text-muted-foreground font-normal">
                    Save to a custom location
                  </div>
                </div>
              </button>
            )}

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

            {isDesktop && (
              <button
                type="button"
                onClick={() => void logApi.exportLogToDefault()}
                className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm"
              >
                <Download size={16} className="text-muted-foreground" />
                <div className="text-left">
                  <div>Export to Default Directory</div>
                  <div className="text-3xs text-muted-foreground font-normal">
                    Save directly to Downloads
                  </div>
                </div>
              </button>
            )}
          </div>
          {!isDesktop && (
            <p className="text-xs text-muted-foreground">
              Logs live on the server host. Desktop-only actions (reveal folder, file export) are
              hidden on the web client — use Copy Log Contents and paste them where you need them.
            </p>
          )}
        </div>
      </div>
    </SettingsSection>
  )
}
