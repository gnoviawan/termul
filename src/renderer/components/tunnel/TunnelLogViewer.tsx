import { ClipboardCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { TunnelLogEntry } from '@/stores/tunnel-store'

interface TunnelLogViewerProps {
  logs: TunnelLogEntry[]
  onClear?: () => void
  className?: string
}

export function TunnelLogViewer({ logs, onClear, className = '' }: TunnelLogViewerProps): React.JSX.Element {
  const handleCopyLogs = async () => {
    const allLogs = [...logs]
      .reverse()
      .map((log) => `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.line}`)
      .join('\n')
    await navigator.clipboard.writeText(allLogs)
    toast.success('Logs copied')
  }

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <div className="text-[11px] font-medium text-muted-foreground">Live Logs</div>
        <div className="flex items-center gap-1">
          <button
            className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-primary transition-colors"
            title="Copy All Logs"
            onClick={handleCopyLogs}
          >
            <ClipboardCheck size={13} />
          </button>
          {onClear && (
            <button
              className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-red-500 transition-colors"
              title="Clear Logs"
              onClick={onClear}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed bg-terminal-bg text-terminal-fg">
        {logs.length > 0 ? (
          <div className="flex flex-col-reverse">
            {logs.map((log, index) => (
              <div
                key={`${log.tunnelId}-${log.timestamp}-${index}`}
                className="whitespace-pre-wrap break-words opacity-80 hover:opacity-100 py-0.5 border-l border-white/5 pl-3 ml-1"
              >
                <span className="text-white/20 mr-2 select-none">
                  [{new Date(log.timestamp).toLocaleTimeString()}]
                </span>
                {log.line}
              </div>
            ))}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground italic opacity-50">
            Waiting for tunnel logs...
          </div>
        )}
      </div>
    </div>
  )
}
