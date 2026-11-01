import { useMemo } from 'react'
import { describeToolCall, toolCallPath } from '@/components/chat/tool-call-summary'
import type { ToolCall } from '@/lib/acp-api'
import type { GitDisplayStatus } from '@/lib/git-status-display'
import { useGitChangedFiles } from './use-git-changed-files'

type ChangedFileKind = 'edit' | 'delete' | 'move'

const KIND_STATUS: Record<ChangedFileKind, GitDisplayStatus> = {
  edit: 'modified',
  delete: 'deleted',
  move: 'renamed'
}

function isChangedFileKind(kind: string | undefined): kind is ChangedFileKind {
  return kind === 'edit' || kind === 'delete' || kind === 'move'
}

/**
 * The kind a call settles the file into, or null when it settles nothing: a
 * failed call changed nothing, and a delete still awaiting approval or running
 * has not removed the file yet.
 */
function settledKind(kind: ChangedFileKind, status: ToolCall['status']): ChangedFileKind | null {
  if (status === 'failed') return null
  if (kind === 'delete' && status !== 'completed') return null
  return kind
}

/** A changed file: from git status, or (outside a git repository) from the
 * ACP tool calls of this session. */
export interface ChangedFile {
  /** Resolved full path — forward slashes, cwd-joined. Also the dedupe key. */
  path: string
  status: GitDisplayStatus | null
  added: number
  removed: number
}

/**
 * POSIX-style normalization on a `/`-separated path: collapse `.` segments
 * and duplicate slashes, resolve `..` by popping the previous segment, strip
 * trailing separators. `..` that would climb past a `/` or `C:/` root is
 * dropped; leading `..` on a relative path is kept (it escapes the base).
 * The drive letter is canonicalized to uppercase (`c:` ≡ `C:` — the rest of
 * the path keeps its case since directories may be case-sensitive) and a
 * leading `//` UNC prefix is preserved. So `./x`, `a//x`, `a/b/../x`, and
 * `x/` all canonicalize alike.
 */
function canonicalizePath(path: string): string {
  const p = path.replace(/^([a-zA-Z]):/, (m) => m.toUpperCase())
  const isDriveRooted = /^[a-zA-Z]:\//.test(p)
  const isUnc = !isDriveRooted && p.startsWith('//')
  const isRooted = isDriveRooted || isUnc || p.startsWith('/')
  const minLen = isDriveRooted ? 1 : 0 // never pop the drive letter
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > minLen && out[out.length - 1] !== '..') {
        out.pop()
      } else if (!isRooted) {
        out.push('..')
      }
      continue
    }
    out.push(seg)
  }
  const body = out.join('/')
  return isRooted ? (isDriveRooted ? body : `${isUnc ? '//' : '/'}${body}`) : body
}

/**
 * `cwd` canonicalized for join/prefix math. An all-separator cwd ('/',
 * '///', '\\\\') survives as '/' so a relative path still joins absolute.
 */
function normalizeCwd(cwd: string): string {
  return canonicalizePath(cwd.replace(/\\/g, '/'))
}

/**
 * Canonical form shared by dedupe, the row tooltip, and the open action:
 * forward slashes, relative paths joined onto `cwd`, then `.`/`..`/duplicate
 * slashes collapsed so all spellings of one file share a key. With no cwd the
 * normalized path stands as given.
 */
function resolveFilePath(path: string, cwd: string): string {
  const normalized = path.replace(/\\/g, '/')
  const isAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')
  const base = normalizeCwd(cwd)
  const joined = isAbsolute || !base ? normalized : `${base}/${normalized}`
  return canonicalizePath(joined)
}

/**
 * Directory portion for the row subtitle: relative to `cwd` when the file sits
 * under it (so `src/components`, not `/work/src/components`), else the full
 * directory part. Empty for basename-only paths.
 */
export function dirName(fullPath: string, cwd: string): string {
  const base = normalizeCwd(cwd)
  // Root cwd: the prefix is '/', not '//'.
  const prefix = base === '/' ? '/' : `${base}/`
  const display = base && fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath
  const idx = display.lastIndexOf('/')
  return idx >= 0 ? display.slice(0, idx) : ''
}

/** Extract file-changing tool calls (edit, delete, move) from the session's
 * tool-call list, deduplicated to one row per resolved path. Paths come from
 * `toolCallPath` (locations → rawInput → diff content) and are normalized via
 * `resolveFilePath`, so `src/foo.ts` and `/work/src/foo.ts` merge under cwd
 * `/work`. Add/remove counts — `describeToolCall().diffStat`, the same
 * battle-tested path used by ToolCallCard — are summed across all contributing
 * calls; `status` comes from the last call that took effect (see
 * `settledKind()`). First-appearance order kept. */
function extractChangedFiles(toolCalls: ToolCall[], cwd: string): ChangedFile[] {
  const files: ChangedFile[] = []
  const byPath = new Map<string, ChangedFile>()
  for (const tc of toolCalls) {
    const kind = tc.kind
    if (!isChangedFileKind(kind)) continue
    // `locations[].path` arrives untrimmed — a whitespace-only path would
    // otherwise key a garbage row like `<cwd>/   `.
    const rawPath = toolCallPath(tc)?.trim()
    if (!rawPath) continue
    const path = resolveFilePath(rawPath, cwd).trim()
    // A dot-only path ('.', 'a/..') can canonicalize to empty.
    if (!path) continue
    const stat = describeToolCall(tc).diffStat ?? { added: 0, removed: 0 }
    const settled = settledKind(kind, tc.status)
    const status = settled && KIND_STATUS[settled]
    const existing = byPath.get(path)
    if (existing) {
      existing.added += stat.added
      existing.removed += stat.removed
      existing.status = status ?? existing.status
      continue
    }
    const file: ChangedFile = {
      path,
      status,
      added: stat.added,
      removed: stat.removed
    }
    byPath.set(path, file)
    files.push(file)
  }
  return files
}

export interface ChatChangedFiles {
  files: ChangedFile[]
  /** The base the paths were resolved against; row subtitles are relative to it. */
  rowBase: string
  /** `git`: uncommitted files of the checkout. `session`: files this session's tool calls touched (no git repository). */
  source: 'git' | 'session'
  totalAdded: number
  totalRemoved: number
}

/**
 * The files a chat changed. In a git repository: the uncommitted files of the
 * checkout at `cwd` (staged, unstaged and untracked, against HEAD) with their
 * git line counts, so a committed, discarded or deleted file drops out and a
 * clean tree lists nothing. Outside a git repository: the files touched by
 * ACP tool calls (edit/delete/move) in the session, one row per file with
 * summed +N −N counts.
 */
export function useChatChangedFiles(
  cwd: string,
  toolCalls: ToolCall[],
  turnActive: boolean
): ChatChangedFiles {
  const git = useGitChangedFiles(cwd, toolCalls, turnActive)
  return useMemo(() => {
    const files =
      git.state === 'unavailable'
        ? extractChangedFiles(toolCalls, cwd)
        : git.state === 'loading'
          ? []
          : git.files.map((file) => ({ ...file, path: resolveFilePath(file.path, git.root) }))
    return {
      files,
      rowBase: git.state === 'ready' ? git.root : cwd,
      source: git.state === 'unavailable' ? 'session' : 'git',
      totalAdded: files.reduce((sum, f) => sum + f.added, 0),
      totalRemoved: files.reduce((sum, f) => sum + f.removed, 0)
    }
  }, [git, toolCalls, cwd])
}
