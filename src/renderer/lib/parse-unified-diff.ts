export type DiffLineKind = 'header' | 'context' | 'deletion' | 'addition' | 'meta'

export interface ParsedDiffLine {
  /** Display text (prefix stripped for hunk body lines). */
  text: string
  /** Raw line from git when needed for headers. */
  raw: string
  kind: DiffLineKind
}

export interface SplitDiffRow {
  left: ParsedDiffLine | null
  right: ParsedDiffLine | null
  /** Metadata / file headers span the full width. */
  fullWidth?: ParsedDiffLine
}

function classifyLine(line: string): DiffLineKind {
  if (
    line.startsWith('@@') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  ) {
    return 'header'
  }
  if (line.startsWith('\\')) {
    return 'meta'
  }
  if (line.startsWith('+')) {
    return 'addition'
  }
  if (line.startsWith('-')) {
    return 'deletion'
  }
  if (line.startsWith(' ')) {
    return 'context'
  }
  return 'header'
}

function stripHunkPrefix(line: string): string {
  return line.length > 0 ? line.slice(1) : ''
}

function toParsedLine(line: string, kind: DiffLineKind): ParsedDiffLine {
  const isHunkBody = kind === 'context' || kind === 'deletion' || kind === 'addition'
  return {
    text: isHunkBody ? stripHunkPrefix(line) : line,
    raw: line,
    kind
  }
}

/** Line-at-a-time model for inline (unified) diff display. */
export function parseUnifiedDiffInline(diff: string): ParsedDiffLine[] {
  if (!diff) {
    return []
  }
  return diff.split('\n').map((line) => {
    const kind = classifyLine(line)
    return toParsedLine(line, kind)
  })
}

/**
 * Pair deletions and additions within a hunk for side-by-side columns.
 * Context lines appear on both sides; file/hunk headers span full width.
 */
export function parseUnifiedDiffSplit(diff: string): SplitDiffRow[] {
  if (!diff) {
    return []
  }

  const lines = diff.split('\n')
  const rows: SplitDiffRow[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const kind = classifyLine(line)

    if (kind === 'header' || kind === 'meta') {
      rows.push({ fullWidth: toParsedLine(line, kind), left: null, right: null })
      i += 1
      continue
    }

    if (kind === 'context') {
      const parsed = toParsedLine(line, 'context')
      rows.push({ left: parsed, right: { ...parsed } })
      i += 1
      continue
    }

    const deletions: string[] = []
    while (i < lines.length && lines[i].startsWith('-')) {
      deletions.push(stripHunkPrefix(lines[i]))
      i += 1
    }

    const additions: string[] = []
    while (i < lines.length && lines[i].startsWith('+')) {
      additions.push(stripHunkPrefix(lines[i]))
      i += 1
    }

    const rowCount = Math.max(deletions.length, additions.length, 1)
    for (let j = 0; j < rowCount; j += 1) {
      const leftText = deletions[j]
      const rightText = additions[j]
      rows.push({
        left:
          leftText !== undefined ? { text: leftText, raw: `-${leftText}`, kind: 'deletion' } : null,
        right:
          rightText !== undefined
            ? { text: rightText, raw: `+${rightText}`, kind: 'addition' }
            : null
      })
    }
  }

  return rows
}

export const GIT_DIFF_VIEW_MODE_KEY = 'termul.gitDiffViewMode'

export type GitDiffViewMode = 'inline' | 'split'

export function loadGitDiffViewMode(): GitDiffViewMode {
  if (typeof localStorage === 'undefined') {
    return 'inline'
  }
  const stored = localStorage.getItem(GIT_DIFF_VIEW_MODE_KEY)
  return stored === 'split' ? 'split' : 'inline'
}

export function saveGitDiffViewMode(mode: GitDiffViewMode): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  localStorage.setItem(GIT_DIFF_VIEW_MODE_KEY, mode)
}
