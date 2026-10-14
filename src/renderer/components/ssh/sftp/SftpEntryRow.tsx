import type { SFTPEntry } from '@shared/types/ssh.types'
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileText,
  Folder,
  Link2,
  Pencil,
  Trash2
} from '@/components/icons'
import { FOCUS_RING_CLASS, QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { formatModified, formatModifiedFull, formatSize } from '@/lib/sftp-format'
import { cn } from '@/lib/utils'

const ACTION_BUTTON = `${QUIET_ICON_BUTTON_CLASS} size-6`
const TEXT_FILE = /\.(log|txt|md|conf|cfg|ini|ya?ml|json|toml|env|csv)$/i

/** Name column inset: row padding, chevron and type icon with their gaps. */
export const SFTP_NAME_INSET_CLASS = 'pl-12'
/** Shared widths so the column header lines up with every row. */
export const SFTP_SIZE_COL_CLASS = 'w-12 shrink-0 text-right'
export const SFTP_MODIFIED_COL_CLASS = 'w-14 shrink-0 text-right'

interface SftpEntryRowProps {
  entry: SFTPEntry
  depth: number
  expanded: boolean
  loading: boolean
  /** The entry shown in the details footer. */
  focused: boolean
  onActivate: () => void
  onFocus: () => void
  /** Files only, desktop only. */
  onDownload?: () => void
  onRename: () => void
  onDelete: () => void
  /** Folder rows on desktop: files dragged from the OS can be dropped into this folder. */
  dropHandlers?: Pick<React.HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>
  /** Files are being dragged over this folder row. */
  dropTarget?: boolean
}

/**
 * One file or folder. Size and modified time sit in fixed columns; on hover
 * or focus the actions take their place, so the row never shifts.
 */
export function SftpEntryRow({
  entry,
  depth,
  expanded,
  loading,
  focused,
  onActivate,
  onFocus,
  onDownload,
  onRename,
  onDelete,
  dropHandlers,
  dropTarget = false
}: SftpEntryRowProps): React.JSX.Element {
  const isDir = entry.entryType === 'directory'
  const Icon = isDir
    ? Folder
    : entry.entryType === 'symlink'
      ? Link2
      : TEXT_FILE.test(entry.name)
        ? FileText
        : File

  // Dropping into a folder is pointer-only; the Upload button is the accessible path.
  return (
    <div
      className={cn(
        'group relative mx-1 flex min-w-0 items-center rounded-md transition-colors duration-150 ease-out',
        dropTarget
          ? 'bg-primary/10 ring-1 ring-inset ring-primary'
          : focused
            ? 'keycap'
            : 'hover:bg-foreground/[0.03]'
      )}
      data-drop-target={dropTarget ? 'true' : undefined}
      {...dropHandlers}
    >
      <button
        type="button"
        className={cn(
          'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md pr-2 text-left text-xs',
          FOCUS_RING_CLASS
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={onActivate}
        onFocus={onFocus}
        aria-expanded={isDir ? expanded : undefined}
        title={isDir ? entry.path : `Open ${entry.name}`}
        // A full-width row shrinking on press reads as the layout jumping.
        data-press-feedback="off"
      >
        <span className="flex w-3.5 shrink-0 justify-center" aria-hidden="true">
          {isDir &&
            (loading ? (
              <Spinner size={12} decorative className="text-muted-foreground" />
            ) : expanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            ))}
        </span>
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
        {/* Read out in the details footer; hidden here so a folder's name stays its label. */}
        <span
          className="flex shrink-0 items-center gap-1.5 text-3xs tabular-nums text-muted-foreground pointer-coarse:invisible pointer-fine:group-hover:invisible group-focus-within:invisible"
          aria-hidden="true"
        >
          <span className={SFTP_SIZE_COL_CLASS}>{isDir ? '' : formatSize(entry.size)}</span>
          <span className={SFTP_MODIFIED_COL_CLASS} title={formatModifiedFull(entry.modifiedAt)}>
            {formatModified(entry.modifiedAt)}
          </span>
        </span>
      </button>
      <div className="absolute right-1 flex items-center transition-opacity duration-150 ease-out pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 group-focus-within:opacity-100">
        {onDownload && (
          <button
            type="button"
            className={ACTION_BUTTON}
            onClick={onDownload}
            aria-label={`Download ${entry.name}`}
            title="Download"
          >
            <Download size={12} />
          </button>
        )}
        <button
          type="button"
          className={ACTION_BUTTON}
          onClick={onRename}
          aria-label={`Rename ${entry.name}`}
          title="Rename"
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          className={cn(ACTION_BUTTON, 'hover:text-destructive')}
          onClick={onDelete}
          aria-label={`Delete ${entry.name}`}
          title="Delete"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}
