export type DiffLineKind = 'header' | 'context' | 'deletion' | 'addition' | 'meta'

export interface ParsedDiffLine {
  /** Display text (prefix stripped for hunk body lines). */
  text: string
  /** Raw line from git when needed for headers. */
  raw: string
  kind: DiffLineKind
  /** Old file line number (for deletions and context). */
  oldLineNumber?: number
  /** New file line number (for additions and context). */
  newLineNumber?: number
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

function extractHunkLineNumbers(hunkHeader: string): { oldStart: number; newStart: number } | null {
  // Parse @@ -oldStart,oldCount +newStart,newCount @@ format
  const match = hunkHeader.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  if (!match) {
    return null
  }
  return {
    oldStart: Number.parseInt(match[1], 10),
    newStart: Number.parseInt(match[2], 10)
  }
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

  const lines = diff.split('\n')
  const result: ParsedDiffLine[] = []
  let oldLineNum = 0
  let newLineNum = 0

  for (const line of lines) {
    const kind = classifyLine(line)

    // Update line counters on hunk headers
    if (kind === 'header' && line.startsWith('@@')) {
      const hunkInfo = extractHunkLineNumbers(line)
      if (hunkInfo) {
        oldLineNum = hunkInfo.oldStart
        newLineNum = hunkInfo.newStart
      }
      result.push(toParsedLine(line, kind))
      continue
    }

    const parsed = toParsedLine(line, kind)

    // Assign line numbers for hunk body lines
    if (kind === 'deletion') {
      parsed.oldLineNumber = oldLineNum
      oldLineNum += 1
    } else if (kind === 'addition') {
      parsed.newLineNumber = newLineNum
      newLineNum += 1
    } else if (kind === 'context') {
      parsed.oldLineNumber = oldLineNum
      parsed.newLineNumber = newLineNum
      oldLineNum += 1
      newLineNum += 1
    }

    result.push(parsed)
  }

  return result
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
  let oldLineNum = 0
  let newLineNum = 0

  while (i < lines.length) {
    const line = lines[i]
    const kind = classifyLine(line)

    if (kind === 'header') {
      // Update line counters on hunk headers
      if (line.startsWith('@@')) {
        const hunkInfo = extractHunkLineNumbers(line)
        if (hunkInfo) {
          oldLineNum = hunkInfo.oldStart
          newLineNum = hunkInfo.newStart
        }
      }
      rows.push({ fullWidth: toParsedLine(line, kind), left: null, right: null })
      i += 1
      continue
    }

    if (kind === 'meta') {
      rows.push({ fullWidth: toParsedLine(line, kind), left: null, right: null })
      i += 1
      continue
    }

    if (kind === 'context') {
      const parsed = toParsedLine(line, 'context')
      parsed.oldLineNumber = oldLineNum
      parsed.newLineNumber = newLineNum
      rows.push({ left: parsed, right: { ...parsed, newLineNumber: newLineNum } })
      oldLineNum += 1
      newLineNum += 1
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
          leftText !== undefined
            ? {
                text: leftText,
                raw: `-${leftText}`,
                kind: 'deletion',
                oldLineNumber: oldLineNum + j
              }
            : null,
        right:
          rightText !== undefined
            ? {
                text: rightText,
                raw: `+${rightText}`,
                kind: 'addition',
                newLineNumber: newLineNum + j
              }
            : null
      })
    }
    oldLineNum += deletions.length
    newLineNum += additions.length
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
