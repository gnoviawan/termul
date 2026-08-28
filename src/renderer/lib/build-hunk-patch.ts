/**
 * Build single-hunk unified-diff patches from a full file diff, one per hunk.
 * Each patch is a self-contained fragment suitable for `git apply --cached`:
 *
 *     --- a/<path>
 *     +++ b/<path>
 *     @@ -oldStart,oldCount +newStart,newCount @@
 *     <context/addition/deletion body lines (raw, with prefix)>
 *
 * Used by GitDiffView for per-hunk stage/unstage (#257). The backend guards
 * that the `a/` / `b/` headers reference the same safe relative `path`, so a
 * renderer-built patch cannot target a path outside the project cwd.
 *
 * The body length is bounded by the `@@` header's declared old/new counts
 * rather than by prefix sniffing, so a body line that happens to look like a
 * file header (e.g. deleting a line whose text is `-- comment` produces the
 * diff line `--- comment`) is not mistaken for a structural header.
 *
 * Phase 2 (#257): `buildLinePatch` builds a partial patch from a subset of a
 * hunk's +/- lines for per-line stage/unstage. Selection semantics mirror
 * `git add -p`'s manual edit: selected additions/deletions are kept; an
 * UNSELECTED DELETION becomes a context line (the index keeps the old text);
 * an UNSELECTED ADDITION is dropped (the new text is left unstaged).
 */
export interface HunkPatch {
  /** Index of the hunk header line in the diff (for keying UI rows). */
  headerIndex: number
  /** Raw `@@ ... @@` header line. */
  headerLine: string
  /** Full patch text ready for `git apply`. */
  patch: string
  /** Diff line indices of the hunk body, in order (context/+/-/\\ meta). */
  bodyLineIndices: number[]
}

interface RichHunk {
  headerIndex: number
  headerLine: string
  bodyLines: string[]
  bodyLineIndices: number[]
  oldLeft: number
  newLeft: number
}

/** Extract the relative path from a `+++ b/<path>` (or `+++ <path>`) header. */
function extractPathFromHeader(line: string): string | null {
  const match = line.match(/^\+\+\+ (?:[ab]\/)?(.+)$/)
  return match ? match[1] : null
}

/** Parse `@@ -oldStart,oldCount +newStart,newCount @@` into the declared body budget. */
function hunkBodyBudget(header: string): { old: number; new: number } | null {
  const m = header.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/)
  if (!m) return null
  // An omitted count means 1 (unified-diff spec).
  return {
    old: m[1] === undefined ? 1 : Number.parseInt(m[1], 10),
    new: m[2] === undefined ? 1 : Number.parseInt(m[2], 10)
  }
}

/** Parse the old/new start line numbers out of a `@@` header. */
function hunkStarts(header: string): { oldStart: number; newStart: number } | null {
  const m = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  if (!m) return null
  return { oldStart: Number.parseInt(m[1], 10), newStart: Number.parseInt(m[2], 10) }
}

function renderPatch(filePath: string, headerLine: string, bodyLines: string[]): string {
  return `--- a/${filePath}\n+++ b/${filePath}\n${headerLine}\n${bodyLines.join('\n')}\n`
}

/**
 * Walk the diff once and collect rich hunk info (body lines paired with their
 * diff line indices). Shared by buildHunkPatches and buildLinePatch so both
 * use identical structural rules.
 */
function collectHunks(diff: string, filePath: string): RichHunk[] {
  const lines = diff.split('\n')
  const hunks: RichHunk[] = []
  let current: RichHunk | null = null
  // File the next hunk belongs to. Defaults to `filePath` so a header-less
  // diff (just `@@` + body) still works; a `+++ b/<path>` line overrides it
  // so a multi-file diff only contributes hunks for the requested file.
  let pendingFilePath: string = filePath

  const flush = (): void => {
    if (!current) return
    hunks.push(current)
    current = null
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    // While a hunk still has declared body budget, consume body/meta lines
    // regardless of their content. This must run BEFORE the structural-header
    // checks below, because a deletion of `-- comment` produces the diff line
    // `--- comment`, which would otherwise look like a file header and
    // truncate the hunk mid-body.
    if (current && (current.oldLeft > 0 || current.newLeft > 0 || line.startsWith('\\'))) {
      if (line.startsWith(' ')) {
        current.bodyLines.push(line)
        current.bodyLineIndices.push(i)
        current.oldLeft -= 1
        current.newLeft -= 1
        continue
      }
      if (line.startsWith('-')) {
        current.bodyLines.push(line)
        current.bodyLineIndices.push(i)
        current.oldLeft -= 1
        continue
      }
      if (line.startsWith('+')) {
        current.bodyLines.push(line)
        current.bodyLineIndices.push(i)
        current.newLeft -= 1
        continue
      }
      if (line.startsWith('\\')) {
        // "\ No newline at end of file" — part of the hunk, no line budget.
        current.bodyLines.push(line)
        current.bodyLineIndices.push(i)
        continue
      }
      // Unexpected line mid-hunk (malformed diff): stop the hunk here.
      flush()
      continue
    }

    if (line.startsWith('@@')) {
      flush()
      const budget = hunkBodyBudget(line)
      current =
        pendingFilePath === filePath && budget
          ? {
              headerIndex: i,
              headerLine: line,
              bodyLines: [],
              bodyLineIndices: [],
              oldLeft: budget.old,
              newLeft: budget.new
            }
          : null
      continue
    }
    if (line.startsWith('diff ')) {
      flush()
      pendingFilePath = filePath
      continue
    }
    if (line.startsWith('+++ ')) {
      flush()
      pendingFilePath = extractPathFromHeader(line) ?? filePath
      continue
    }
    if (line.startsWith('--- ')) {
      flush()
    }
    // Stray text outside a hunk (e.g. "diff --git" preamble already handled):
    // ignore.
  }
  flush()
  return hunks
}

export function buildHunkPatches(diff: string, filePath: string): HunkPatch[] {
  if (!diff || !filePath) return []
  return collectHunks(diff, filePath).map((hunk) => ({
    headerIndex: hunk.headerIndex,
    headerLine: hunk.headerLine,
    patch: renderPatch(filePath, hunk.headerLine, hunk.bodyLines),
    bodyLineIndices: hunk.bodyLineIndices
  }))
}

/**
 * Phase 2 (#257): build a partial single-hunk patch from the selected subset
 * of one hunk's +/- lines. Line indices are positions in the raw diff string
 * (the same indices GitDiffView renders). Returns null when the selection
 * contains no +/- line (nothing to stage), when the hunk cannot be found, or
 * when the diff is malformed.
 */
export function buildLinePatch(
  diff: string,
  filePath: string,
  headerIndex: number,
  selectedIndices: ReadonlySet<number>
): string | null {
  if (!diff || !filePath || selectedIndices.size === 0) return null
  const hunk = collectHunks(diff, filePath).find((h) => h.headerIndex === headerIndex)
  if (!hunk) return null
  const starts = hunkStarts(hunk.headerLine)
  if (!starts) return null

  const out: string[] = []
  let contextCount = 0
  let delCount = 0
  let addCount = 0
  // Tracks whether the immediately preceding diff line survived the
  // transform, and with which role — a `\ No newline at end of file` marker
  // belongs to the line above it and must follow that line's fate.
  let prevKept: 'context' | 'deletion' | 'addition' | null = null

  for (let i = 0; i < hunk.bodyLines.length; i += 1) {
    const raw = hunk.bodyLines[i]
    const lineIndex = hunk.bodyLineIndices[i]
    const selected = selectedIndices.has(lineIndex)

    if (raw.startsWith(' ')) {
      out.push(raw)
      contextCount += 1
      prevKept = 'context'
    } else if (raw.startsWith('-')) {
      if (selected) {
        out.push(raw)
        delCount += 1
        prevKept = 'deletion'
      } else {
        // Unselected deletion: the index keeps the old text, so the line
        // becomes context in the partial patch.
        out.push(` ${raw.slice(1)}`)
        contextCount += 1
        prevKept = 'context'
      }
    } else if (raw.startsWith('+')) {
      if (selected) {
        out.push(raw)
        addCount += 1
        prevKept = 'addition'
      } else {
        // Unselected addition: dropped — the new text stays unstaged.
        prevKept = null
      }
    } else if (raw.startsWith('\\')) {
      // Keep the no-newline marker iff the line it annotates was kept.
      // (After a kept deletion-turned-context it still describes the old
      // file's ending, which the index retains.)
      if (prevKept !== null) out.push(raw)
    }
  }

  if (delCount + addCount === 0) return null

  const oldCount = contextCount + delCount
  const newCount = contextCount + addCount
  const header = `@@ -${starts.oldStart},${oldCount} +${starts.newStart},${newCount} @@`
  return renderPatch(filePath, header, out)
}
