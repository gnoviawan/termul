import { toast } from 'sonner'
import { Copy, FileQuestion, FolderOpen } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { clipboardApi, openerApi } from '@/lib/api'
import { basename } from '@/lib/path-basename'
import { formatSize } from '@/lib/sftp-format'
import { isTauriContext } from '@/lib/tauri-runtime'
import { parseTooLarge, type UnsupportedReason } from '@/stores/editor-file-state'

/** Why a file has no preview. */
export type PreviewUnavailable =
  | UnsupportedReason
  | { reason: 'missing' }
  | { reason: 'unreadable'; message: string }

/** A failed `readMediaBytes` result as the state to show instead of the viewer. */
export function previewUnavailableFromRead(code: string, message: string): PreviewUnavailable {
  switch (code) {
    case 'FILE_TOO_LARGE':
      return { reason: 'too-large', ...parseTooLarge(message) }
    case 'NOT_FOUND':
    case 'NOT_A_FILE':
      return { reason: 'missing' }
    default:
      return { reason: 'unreadable', message }
  }
}

function headline(unavailable: PreviewUnavailable): string {
  switch (unavailable.reason) {
    case 'binary':
      return "This file can't be previewed"
    case 'too-large':
      return 'This file is too large to preview'
    case 'missing':
      return 'This file no longer exists'
    case 'unreadable':
      return "This file couldn't be read"
  }
}

function detail(unavailable: PreviewUnavailable): string | null {
  switch (unavailable.reason) {
    case 'binary':
      return unavailable.size === undefined ? null : formatSize(unavailable.size)
    case 'too-large': {
      const { size, limit } = unavailable
      if (size !== undefined && limit !== undefined) {
        return `${formatSize(size)}, the preview limit is ${formatSize(limit)}`
      }
      return size === undefined ? null : formatSize(size)
    }
    case 'missing':
      return null
    case 'unreadable':
      return unavailable.message
  }
}

async function revealInFileManager(filePath: string): Promise<void> {
  const result = await openerApi.revealInFileManager(filePath)
  if (!result.success) toast.error(`Failed to reveal in file manager: ${result.error}`)
}

async function copyPath(filePath: string): Promise<void> {
  await clipboardApi.writeText(filePath)
  toast.success('Path copied', { description: filePath })
}

export function UnsupportedFileView({
  filePath,
  unavailable
}: {
  filePath: string
  unavailable: PreviewUnavailable
}): React.JSX.Element {
  const note = detail(unavailable)
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      <FileQuestion size={32} aria-hidden="true" className="text-muted-foreground" />
      <div className="flex max-w-md flex-col gap-1">
        <p className="truncate text-sm font-medium text-foreground" title={filePath}>
          {basename(filePath)}
        </p>
        <p className="text-xs text-muted-foreground">{headline(unavailable)}</p>
        {note && <p className="text-xs text-muted-foreground tabular-nums">{note}</p>}
      </div>
      <div className="flex items-center gap-2">
        {/* The OS file manager is desktop-only; Copy Path works on every surface. */}
        {isTauriContext() && unavailable.reason !== 'missing' && (
          <Button variant="outline" size="sm" onClick={() => void revealInFileManager(filePath)}>
            <FolderOpen aria-hidden="true" /> Show in File Manager
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void copyPath(filePath)}>
          <Copy aria-hidden="true" /> Copy Path
        </Button>
      </div>
    </div>
  )
}
