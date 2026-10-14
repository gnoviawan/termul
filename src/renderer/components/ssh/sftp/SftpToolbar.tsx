import { ArrowUp, FilePlus, FolderPlus, RefreshCw, Upload } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'

const ICON_BUTTON = `${QUIET_ICON_BUTTON_CLASS} size-6.5`

interface SftpToolbarProps {
  /** The folder is known (the first listing has resolved). */
  hasPath: boolean
  atRoot: boolean
  onUp: () => void
  onRefresh: () => void
  onNewFolder: () => void
  onNewFile: () => void
  /** Desktop only: upload needs local file paths. */
  onUpload?: () => void
}

/** Title row of the remote file browser with its folder actions. */
export function SftpToolbar({
  hasPath,
  atRoot,
  onUp,
  onRefresh,
  onNewFolder,
  onNewFile,
  onUpload
}: SftpToolbarProps): React.JSX.Element {
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border pl-3 pr-1.5">
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">Files</span>
      <button
        type="button"
        className={ICON_BUTTON}
        onClick={onUp}
        disabled={!hasPath || atRoot}
        aria-label="Up one folder"
        title="Up one folder"
      >
        <ArrowUp size={13} />
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        onClick={onRefresh}
        aria-label="Refresh"
        title="Refresh"
      >
        <RefreshCw size={13} />
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        onClick={onNewFolder}
        disabled={!hasPath}
        aria-label="New folder"
        title="New folder"
      >
        <FolderPlus size={13} />
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        onClick={onNewFile}
        disabled={!hasPath}
        aria-label="New file"
        title="New file"
      >
        <FilePlus size={13} />
      </button>
      {onUpload && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ml-1 h-6.5 gap-1.5 px-2"
          onClick={onUpload}
          disabled={!hasPath}
          title="Upload files (or drop them here)"
        >
          <Upload aria-hidden="true" />
          Upload
        </Button>
      )}
    </div>
  )
}
