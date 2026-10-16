import type { GitCommit, GitCommitFile, GitCommitFileStatus } from '@shared/types/ipc.types'
import type React from 'react'
import { useEffect } from 'react'
import {
  AlertTriangle,
  Clock,
  Copy,
  FileDiff,
  GitCommit as GitCommitIcon,
  GitMerge,
  X
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { formatRelativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { commitDetailKey, useGitHistoryStore } from '@/stores/git-history-store'
import { AuthorAvatar } from './author-avatar'
import { RefChip } from './lane-graph'

interface CommitDetailPaneProps {
  cwd: string
  commit: GitCommit
  onOpenFile: (file: GitCommitFile) => void
  onCopyHash: () => void
  onSelectCommit: (hash: string) => void
  /** Overlay mode only: closes the pane. */
  onClose?: () => void
}

/** How long the selection must rest on a commit before its detail loads. */
export const DETAIL_LOAD_DELAY_MS = 120

const STATUS_CLASS: Partial<Record<GitCommitFileStatus, string>> = {
  A: 'text-success',
  D: 'text-destructive',
  M: 'text-warning'
}

const STATUS_LABEL: Record<GitCommitFileStatus, string> = {
  A: 'Added',
  C: 'Copied',
  D: 'Deleted',
  M: 'Modified',
  R: 'Renamed',
  T: 'Type changed'
}

function formatFullDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

/** The commit message after the subject line, without leading blank lines. */
export function commitBody(message: string): string {
  const newline = message.indexOf('\n')
  return newline < 0 ? '' : message.slice(newline + 1).trim()
}

/**
 * Right pane of the main-panel Git History: refs, subject, full message,
 * author, date, full hash, parents and the changed files. A file opens its
 * read-only diff in a tab. The detail loads once per commit through
 * `git-history-store`, once the selection has rested for {@link DETAIL_LOAD_DELAY_MS}.
 */
export function CommitDetailPane({
  cwd,
  commit,
  onOpenFile,
  onCopyHash,
  onSelectCommit,
  onClose
}: CommitDetailPaneProps): React.JSX.Element {
  const entry = useGitHistoryStore((state) => state.details[commitDetailKey(cwd, commit.hash)])
  const loadCommitDetail = useGitHistoryStore((state) => state.loadCommitDetail)

  // Holding an arrow key moves the selection through many commits; load only
  // the one the selection settles on. A cached commit needs no wait.
  useEffect(() => {
    if (useGitHistoryStore.getState().details[commitDetailKey(cwd, commit.hash)]) {
      void loadCommitDetail(cwd, commit.hash)
      return
    }
    const timer = setTimeout(() => void loadCommitDetail(cwd, commit.hash), DETAIL_LOAD_DELAY_MS)
    return () => clearTimeout(timer)
  }, [cwd, commit.hash, loadCommitDetail])

  const detail = entry?.detail ?? null
  const body = detail ? commitBody(detail.message) : ''
  const totals = detail?.files.reduce(
    (sum, f) => ({ added: sum.added + (f.added ?? 0), removed: sum.removed + (f.removed ?? 0) }),
    { added: 0, removed: 0 }
  )

  return (
    <ScrollArea className="h-full">
      <section aria-label="Commit details" className="flex flex-col">
        <div className="flex flex-col gap-2.5 p-4">
          {(commit.refs.length > 0 || onClose) && (
            <div className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {commit.refs.map((ref) => (
                  <RefChip key={ref} raw={ref} />
                ))}
              </div>
              {onClose && (
                <button
                  type="button"
                  aria-label="Close details"
                  className={cn(PANEL_ICON_BUTTON_CLASS, '-mr-1.5 -mt-1.5 shrink-0')}
                  onClick={onClose}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          <h2 className="select-text break-words text-[15px] font-medium leading-snug text-foreground">
            {commit.subject || '(no message)'}
          </h2>
          {body && (
            <p className="select-text whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
              {body}
            </p>
          )}

          <dl className="mt-1 flex flex-col gap-1.5 text-xs text-muted-foreground">
            <MetaRow label="Author" icon={<AuthorAvatar name={commit.author} />}>
              <span className="select-text truncate text-foreground/80">
                {commit.author}
                {detail?.authorEmail && (
                  <span className="text-muted-foreground"> &lt;{detail.authorEmail}&gt;</span>
                )}
              </span>
            </MetaRow>
            <MetaRow label="Date" icon={<Clock size={14} />}>
              <span className="truncate tabular-nums">
                {formatFullDate(commit.date)} · {formatRelativeTime(commit.date)}
              </span>
            </MetaRow>
            <MetaRow label="Hash" icon={<GitCommitIcon size={14} />}>
              <span className="min-w-0 select-text truncate font-mono">{commit.hash}</span>
              <button
                type="button"
                aria-label="Copy full hash"
                title="Copy full hash"
                className={cn(PANEL_ICON_BUTTON_CLASS, 'size-6 shrink-0')}
                onClick={onCopyHash}
              >
                <Copy size={12} />
              </button>
            </MetaRow>
            {commit.parents.length > 0 && (
              <MetaRow
                label={commit.parents.length > 1 ? 'Parents' : 'Parent'}
                icon={<GitMerge size={14} />}
              >
                <span className="shrink-0">{commit.parents.length > 1 ? 'Parents' : 'Parent'}</span>
                {commit.parents.map((parent) => (
                  <button
                    key={parent}
                    type="button"
                    title={`Select ${parent}`}
                    className="shrink-0 rounded font-mono text-foreground/80 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onSelectCommit(parent)}
                  >
                    {parent.slice(0, 7)}
                  </button>
                ))}
              </MetaRow>
            )}
          </dl>

          <div className="mt-1 flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onCopyHash}>
              <Copy size={13} />
              Copy hash
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!detail || detail.files.length === 0}
              onClick={() => detail?.files[0] && onOpenFile(detail.files[0])}
            >
              <FileDiff size={13} />
              Open diff
            </Button>
          </div>
        </div>

        <div className="flex h-9 items-center gap-2 border-t border-border px-4">
          <span className="label-panel">
            {detail
              ? `${detail.files.length}${detail.filesTruncated ? '+' : ''} ${detail.files.length === 1 ? 'file' : 'files'} changed`
              : 'Files changed'}
          </span>
          <span className="flex-1" />
          {totals && (
            <span className="text-2xs tabular-nums">
              <DiffStatCounts added={totals.added} removed={totals.removed} omitZero />
            </span>
          )}
        </div>

        {entry?.error ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-xs text-muted-foreground">
            <AlertTriangle size={16} />
            <p className="break-words">Couldn't load this commit: {entry.error}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void loadCommitDetail(cwd, commit.hash)}
            >
              Retry
            </Button>
          </div>
        ) : !detail ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner size={14} decorative />
            Loading files...
          </div>
        ) : detail.files.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            This commit changes no files.
          </p>
        ) : (
          <ul className="flex flex-col px-2 pb-3">
            {detail.files.map((file) => (
              <li key={`${file.oldPath ?? ''}\u0000${file.path}`}>
                <FileRow file={file} onOpen={() => onOpenFile(file)} />
              </li>
            ))}
            {detail.filesTruncated && (
              <li className="px-2 pt-2 text-2xs text-muted-foreground">
                Only the first {detail.files.length} files are shown.
              </li>
            )}
          </ul>
        )}
      </section>
    </ScrollArea>
  )
}

function MetaRow({
  label,
  icon,
  children
}: {
  label: string
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-6 items-center gap-2">
      <dt className="sr-only">{label}</dt>
      <span aria-hidden="true" className="flex w-4 shrink-0 justify-center">
        {icon}
      </span>
      <dd className="flex min-w-0 flex-1 items-center gap-1.5">{children}</dd>
    </div>
  )
}

function FileRow({ file, onOpen }: { file: GitCommitFile; onOpen: () => void }): React.JSX.Element {
  const { name, dir } = splitPath(file.path)
  const deleted = file.status === 'D'
  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
  return (
    <button
      type="button"
      title={`${title} — open diff`}
      onClick={onOpen}
      className="group flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 ease-out hover:bg-foreground/[0.04] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={cn(
          'w-3 shrink-0 text-center font-mono text-2xs font-semibold',
          STATUS_CLASS[file.status] ?? 'text-muted-foreground'
        )}
        title={STATUS_LABEL[file.status]}
      >
        {file.status}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span
          className={cn('shrink-0 text-xs', deleted ? 'text-muted-foreground' : 'text-foreground')}
        >
          {name}
        </span>
        {dir && <span className="min-w-0 truncate text-2xs text-muted-foreground">{dir}</span>}
      </span>
      <span className="shrink-0 text-2xs tabular-nums">
        {file.added === null ? (
          <span className="text-muted-foreground">bin</span>
        ) : (
          <DiffStatCounts added={file.added} removed={file.removed ?? 0} omitZero />
        )}
      </span>
    </button>
  )
}
