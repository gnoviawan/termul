import { Upload } from '@/components/icons'
import { cn } from '@/lib/utils'

/**
 * Drop target shown while files from the OS are dragged over the panel.
 * Over the open folder the veil keeps the label readable over the file list;
 * over a folder row the veil steps aside so the highlighted row stays visible,
 * and a chip names that folder instead. Blue marks the drop target. Visual
 * only: the Upload button is the accessible path.
 */
export function SftpDropOverlay({
  active,
  path,
  intoRow
}: {
  active: boolean
  /** Where the files will go. */
  path: string
  /** The target is a folder row in the list, not the open folder. */
  intoRow: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-1 z-20 rounded-lg border border-dashed border-primary transition-opacity duration-150 ease-out',
        active ? 'opacity-100' : 'opacity-0'
      )}
      aria-hidden="true"
      data-testid="sftp-drop-overlay"
      data-active={active ? 'true' : undefined}
      data-target={path}
    >
      {intoRow ? (
        <p className="absolute inset-x-2 bottom-2 truncate rounded-md border border-border bg-popover px-2 py-1 text-2xs text-foreground shadow-sm">
          Upload to <span className="font-mono">{path}</span>
        </p>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg bg-background/85">
          <div className="absolute inset-0 rounded-lg bg-primary/5" />
          <Upload size={20} className="relative text-primary" />
          <p className="relative text-sm font-medium text-foreground">Drop to upload</p>
          <p className="relative max-w-full truncate px-4 font-mono text-2xs text-muted-foreground">
            {path}
          </p>
        </div>
      )}
    </div>
  )
}
