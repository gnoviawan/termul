import { toast } from 'sonner'
import { CHAT_HIT_MIN_H } from '@/components/chat/chat-layout'
import { baseName } from '@/components/chat/tool-call-summary'
import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import { GitStatusLetter } from '@/components/git/rows'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { GIT_STATUS_LABEL } from '@/lib/git-status-display'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { type ChangedFile, dirName } from './use-chat-changed-files'

/** Open a changed file in the editor workspace; a failure toasts and logs. */
export async function openChangedFile(fullPath: string): Promise<void> {
  try {
    await useEditorStore.getState().openFile(fullPath)
    useWorkspaceStore.getState().addEditorTab(fullPath)
  } catch (error) {
    toast.error('Could not open file')
    void logFrontendError({
      level: 'warn',
      message: `ChangedFilesList: openFile failed for ${fullPath}: ${String(error)}`,
      source: 'ChangedFilesList'
    })
  }
}

function FileRow({
  file,
  cwd,
  onOpen
}: {
  file: ChangedFile
  cwd: string
  onOpen: (path: string) => void
}) {
  // `file.path` is already the resolved full path; `dir` shows it relative to
  // `cwd` when the file sits underneath (GitPanel FileItem row shape).
  const dir = dirName(file.path, cwd)
  // A separators-only path ('/') has no basename — show the path itself.
  const label = baseName(file.path) || file.path
  const hasCounts = file.added > 0 || file.removed > 0
  const status = file.status
  const isDeleted = status === 'deleted'

  const content = (
    <>
      <MaterialFileIcon name={label} isDirectory={false} isExpanded={false} depth={0} size={14} />
      <span className={cn('min-w-0 flex-1', isDeleted && 'line-through')}>
        <span className="block truncate text-2xs font-medium leading-tight">{label}</span>
        {dir && <span className="block truncate text-4xs leading-tight opacity-50">{dir}</span>}
      </span>
      {hasCounts && (
        <span className="shrink-0 font-mono text-2xs leading-tight">
          <DiffStatCounts added={file.added} removed={file.removed} />
        </span>
      )}
      {status && <GitStatusLetter status={status} />}
    </>
  )
  const rowClass = cn(
    'flex w-full items-center gap-2 rounded-md px-3 text-left text-muted-foreground select-none',
    CHAT_HIT_MIN_H
  )

  if (isDeleted) {
    const deletedLabel = `Deleted: ${file.path}`
    return (
      // biome-ignore lint/a11y/useSemanticElements: a fieldset would give a static row form semantics
      <div
        role="group"
        title={deletedLabel}
        aria-label={deletedLabel}
        className={cn(rowClass, 'cursor-default')}
      >
        {content}
      </div>
    )
  }

  return (
    <button
      type="button"
      data-press-feedback="off"
      title={file.path}
      // `title` is hover-only; the aria-label carries the resolved path and the
      // change kind to touch and screen-reader users.
      aria-label={status ? `${file.path}, ${GIT_STATUS_LABEL[status]}` : file.path}
      onClick={() => onOpen(file.path)}
      className={cn(
        rowClass,
        'group/row cursor-pointer transition-[background-color,color] duration-150 ease-out motion-reduce:transition-none',
        'hover:bg-secondary/60 hover:text-foreground',
        'active:bg-secondary/80',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
      )}
    >
      {content}
    </button>
  )
}

/** One row per changed file; a deleted file's row is inert and struck through. */
export function ChangedFilesRows({
  files,
  rowBase,
  onOpen,
  className
}: {
  files: readonly ChangedFile[]
  rowBase: string
  onOpen: (path: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('scroller-thin max-h-72 overflow-y-auto overscroll-contain', className)}>
      <div className="space-y-0.5 p-1">
        {files.map((file) => (
          <FileRow key={file.path} file={file} cwd={rowBase} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}
