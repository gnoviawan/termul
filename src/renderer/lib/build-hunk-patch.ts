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
 */
export interface HunkPatch {
  /** Index of the hunk header line in the diff (for keying UI rows). */
  headerIndex: number
  /** Raw `@@ ... @@` header line. */
  headerLine: string
  /** Full patch text ready for `git apply`. */
  patch: string
}

interface ActiveHunk {
  headerIndex: number
  headerLine: string
  bodyLines: string[]
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

export function buildHunkPatches(diff: string, filePath: string): HunkPatch[] {
  if (!diff || !filePath) return []
  const lines = diff.split('\n')
  const hunks: HunkPatch[] = []
  let current: ActiveHunk | null = null
  // File the next hunk belongs to. Defaults to `filePath` so a header-less
  // diff (just `@@` + body) still works; a `+++ b/<path>` line overrides it
  // so a multi-file diff only contributes hunks for the requested file.
  let pendingFilePath: string = filePath

  const flush = (): void => {
    if (!current) return
    const patch =
      `--- a/${filePath}\n` +
      `+++ b/${filePath}\n` +
      `${current.headerLine}\n` +
      current.bodyLines.join('\n') +
      '\n'
    hunks.push({
      headerIndex: current.headerIndex,
      headerLine: current.headerLine,
      patch
    })
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
        current.oldLeft -= 1
        current.newLeft -= 1
        continue
      }
      if (line.startsWith('-')) {
        current.bodyLines.push(line)
        current.oldLeft -= 1
        continue
      }
      if (line.startsWith('+')) {
        current.bodyLines.push(line)
        current.newLeft -= 1
        continue
      }
      if (line.startsWith('\\')) {
        // "\ No newline at end of file" — part of the hunk, no line budget.
        current.bodyLines.push(line)
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
