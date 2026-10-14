import type { SFTPEntry } from '@shared/types/ssh.types'
import { formatModifiedFull, formatPermissions, formatSize } from '@/lib/sftp-format'

/** Permissions, owner, size and modified time of the focused entry. */
export function SftpDetailsFooter({ entry }: { entry: SFTPEntry }): React.JSX.Element {
  const meta = [
    formatPermissions(entry.permissions),
    entry.owner,
    entry.entryType === 'directory' ? null : formatSize(entry.size)
  ].filter(Boolean)
  const modified = formatModifiedFull(entry.modifiedAt)
  return (
    <section
      className="shrink-0 space-y-0.5 border-t border-border bg-card px-3 py-2.5"
      aria-label={`Details for ${entry.name}`}
      aria-live="polite"
      data-testid="sftp-details"
    >
      <p className="truncate text-xs font-medium text-foreground" title={entry.path}>
        {entry.name}
      </p>
      {meta.length > 0 && (
        <p className="truncate font-mono text-2xs tabular-nums text-muted-foreground">
          {meta.join(' · ')}
        </p>
      )}
      {modified && <p className="text-2xs text-muted-foreground">Modified {modified}</p>}
    </section>
  )
}
