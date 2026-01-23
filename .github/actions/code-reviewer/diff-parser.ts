/**
 * Diff parser for extracting and analyzing code changes from Pull Request diffs
 * Handles unified diff format with proper error handling and edge case detection
 */

/**
 * Change type in a diff hunk
 */
export type ChangeType = 'added' | 'removed' | 'modified' | 'context'

/**
 * Single line change in a diff
 */
export interface DiffLine {
  type: ChangeType
  content: string
  lineNumber?: number
  oldLineNumber?: number
}

/**
 * A hunk of changes in a diff
 */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

/**
 * Parsed diff for a single file
 */
export interface ParsedDiff {
  filePath: string
  oldFilePath?: string
  isNew: boolean
  isDeleted: boolean
  isBinary: boolean
  isRename: boolean
  hunks: DiffHunk[]
  language?: string
  additions: number
  deletions: number
}

/**
 * Options for parsing diffs
 */
export interface ParseDiffOptions {
  maxHunks?: number
  maxFileSize?: number
  excludePatterns?: string[]
  includeBinary?: boolean
}

/**
 * Error types for diff parsing
 */
export const DiffParserErrorCodes = {
  INVALID_DIFF: 'INVALID_DIFF',
  BINARY_FILE: 'BINARY_FILE',
  MERGE_CONFLICT: 'MERGE_CONFLICT',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  EMPTY_DIFF: 'EMPTY_DIFF',
  PARSE_ERROR: 'PARSE_ERROR'
} as const

export type DiffParserErrorCode = (typeof DiffParserErrorCodes)[keyof typeof DiffParserErrorCodes]

/**
 * Custom error class for diff parsing operations
 */
export class DiffParserError extends Error {
  constructor(
    message: string,
    public code: DiffParserErrorCode,
    public filePath?: string
  ) {
    super(message)
    this.name = 'DiffParserError'
  }
}

/**
 * Common binary file extensions
 */
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'svg',
  'webp',
  'pdf',
  'zip',
  'tar',
  'gz',
  'rar',
  '7z',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'dat',
  'db',
  'sqlite',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'mp3',
  'mp4',
  'avi',
  'mov',
  'wav',
  'flac',
  'ogg',
  'class',
  'jar',
  'war',
  'ear',
  'swf',
  'flv',
  'pyc',
  'pyo',
  'node'
])

/**
 * Language detection based on file extension
 */
const LANGUAGE_MAP: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  py: 'Python',
  java: 'Java',
  cpp: 'C++',
  c: 'C',
  cs: 'C#',
  go: 'Go',
  rs: 'Rust',
  php: 'PHP',
  rb: 'Ruby',
  swift: 'Swift',
  kt: 'Kotlin',
  scala: 'Scala',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  xml: 'XML',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  md: 'Markdown',
  sql: 'SQL'
}

/**
 * Check if a file is likely binary based on extension
 *
 * @param filePath - Path to the file
 * @returns true if file has a binary extension
 */
function isLikelyBinaryFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext ? BINARY_EXTENSIONS.has(ext) : false
}

/**
 * Parse a unified diff string into structured data
 *
 * @param diff - The unified diff string from GitHub API
 * @param filePath - Path to the file (for context)
 * @param options - Parsing options
 * @returns Parsed diff with hunks and line changes
 * @throws DiffParserError if the diff is invalid or contains merge conflicts
 */
export function parseDiff(
  diff: string | null | undefined,
  filePath: string,
  options: ParseDiffOptions = {}
): ParsedDiff | null {
  // Handle null or empty diff
  if (!diff || diff.trim().length === 0) {
    return null
  }

  // Early binary file detection by extension
  if (isLikelyBinaryFile(filePath)) {
    if (!options.includeBinary) {
      throw new DiffParserError(
        'Binary file detected (by extension) and excluded',
        DiffParserErrorCodes.BINARY_FILE,
        filePath
      )
    }
    return {
      filePath,
      isNew: false,
      isDeleted: false,
      isBinary: true,
      isRename: false,
      hunks: [],
      language: detectLanguage(filePath),
      additions: 0,
      deletions: 0
    }
  }

  const opts = {
    maxHunks: 100,
    maxFileSize: 1000000, // 1MB
    excludePatterns: [],
    includeBinary: false,
    ...options
  }

  // Check for binary file marker
  if (diff.includes('Binary files') || diff.includes('GIT binary patch')) {
    if (!opts.includeBinary) {
      throw new DiffParserError(
        'Binary file detected and excluded',
        DiffParserErrorCodes.BINARY_FILE,
        filePath
      )
    }
    return {
      filePath,
      isNew: false,
      isDeleted: false,
      isBinary: true,
      isRename: false,
      hunks: [],
      language: detectLanguage(filePath),
      additions: 0,
      deletions: 0
    }
  }

  // Check for merge conflict markers
  if (hasMergeConflicts(diff)) {
    throw new DiffParserError(
      'Merge conflict markers detected in diff',
      DiffParserErrorCodes.MERGE_CONFLICT,
      filePath
    )
  }

  // Check file size
  if (diff.length > opts.maxFileSize) {
    throw new DiffParserError(
      `Diff size (${diff.length} bytes) exceeds maximum (${opts.maxFileSize} bytes)`,
      DiffParserErrorCodes.FILE_TOO_LARGE,
      filePath
    )
  }

  // Check for empty diff (only headers, no actual changes)
  const hasChanges = diff.split('\n').some(
    (line) => line.startsWith('+') || line.startsWith('-')
  )
  if (!hasChanges) {
    throw new DiffParserError(
      'Empty diff detected (no actual changes)',
      DiffParserErrorCodes.EMPTY_DIFF,
      filePath
    )
  }

  // Check exclude patterns
  if (shouldExclude(filePath, opts.excludePatterns)) {
    return null
  }

  try {
    const lines = diff.split('\n')
    const result: ParsedDiff = {
      filePath,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: [],
      language: detectLanguage(filePath),
      additions: 0,
      deletions: 0
    }

    let currentHunk: DiffHunk | null = null
    let oldLineNumber = 0
    let newLineNumber = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Parse file headers
      if (line.startsWith('--- ')) {
        const oldPath = line.substring(4).trim()
        if (oldPath !== '/dev/null') {
          result.oldFilePath = oldPath
          result.isNew = false
        } else {
          result.isNew = true
        }
        continue
      }

      if (line.startsWith('+++ ')) {
        const newPath = line.substring(4).trim()
        if (newPath !== '/dev/null') {
          result.filePath = newPath
          result.isDeleted = false
        } else {
          result.isDeleted = true
        }
        // Check for rename
        if (result.oldFilePath && result.oldFilePath !== newPath && newPath !== '/dev/null') {
          result.isRename = true
        }
        continue
      }

      // Parse hunk header
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
      if (hunkMatch) {
        // Save previous hunk
        if (currentHunk) {
          result.hunks.push(currentHunk)
        }

        // Check hunk limit
        if (result.hunks.length >= opts.maxHunks) {
          break
        }

        // Start new hunk
        oldLineNumber = parseInt(hunkMatch[1], 10)
        newLineNumber = parseInt(hunkMatch[3], 10)
        const oldLines = parseInt(hunkMatch[2] || '1', 10)
        const newLines = parseInt(hunkMatch[4] || '1', 10)

        currentHunk = {
          oldStart: oldLineNumber,
          oldLines,
          newStart: newLineNumber,
          newLines,
          lines: []
        }
        continue
      }

      // Parse diff lines
      if (currentHunk) {
        const diffLine = parseDiffLine(line, oldLineNumber, newLineNumber)
        if (diffLine) {
          currentHunk.lines.push(diffLine)

          // Update line numbers
          if (diffLine.type === 'removed' || diffLine.type === 'context') {
            oldLineNumber++
          }
          if (diffLine.type === 'added' || diffLine.type === 'context') {
            newLineNumber++
          }

          // Count additions and deletions
          if (diffLine.type === 'added') {
            result.additions++
          } else if (diffLine.type === 'removed') {
            result.deletions++
          }
        }
      }
    }

    // Save last hunk
    if (currentHunk) {
      result.hunks.push(currentHunk)
    }

    // Validate that we got some hunks
    if (result.hunks.length === 0) {
      return null
    }

    return result
  } catch (error) {
    if (error instanceof DiffParserError) {
      throw error
    }
    throw new DiffParserError(
      `Failed to parse diff: ${error instanceof Error ? error.message : 'Unknown error'}`,
      DiffParserErrorCodes.PARSE_ERROR,
      filePath
    )
  }
}

/**
 * Parse a single diff line
 */
function parseDiffLine(
  line: string,
  oldLineNumber: number,
  newLineNumber: number
): DiffLine | null {
  // Skip empty lines and non-diff lines
  if (line.length === 0 || (!line.startsWith('+') && !line.startsWith('-') && !line.startsWith(' '))) {
    return null
  }

  const firstChar = line.charAt(0)
  const content = line.substring(1)
  const result: DiffLine = {
    type: 'context',
    content,
    lineNumber: undefined,
    oldLineNumber: undefined
  }

  if (firstChar === '+') {
    result.type = 'added'
    result.lineNumber = newLineNumber
  } else if (firstChar === '-') {
    result.type = 'removed'
    result.oldLineNumber = oldLineNumber
  } else {
    result.type = 'context'
    result.lineNumber = newLineNumber
    result.oldLineNumber = oldLineNumber
  }

  return result
}

/**
 * Extract only the changed lines from a parsed diff
 *
 * @param parsedDiff - The parsed diff to extract changes from
 * @returns String containing only added and modified lines
 */
export function extractChanges(parsedDiff: ParsedDiff): string {
  if (parsedDiff.hunks.length === 0) {
    return ''
  }

  const changes: string[] = []

  for (const hunk of parsedDiff.hunks) {
    // Add hunk header for context
    changes.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)

    // Add changed lines (added and removed, skip context)
    for (const line of hunk.lines) {
      if (line.type === 'added') {
        changes.push(`+${line.content}`)
      } else if (line.type === 'removed') {
        changes.push(`-${line.content}`)
      } else if (line.type === 'context') {
        // Include some context for readability
        changes.push(` ${line.content}`)
      }
    }
  }

  return changes.join('\n')
}

/**
 * Get line ranges for all changes in a diff
 *
 * @param parsedDiff - The parsed diff
 * @returns Array of line ranges [start, end]
 */
export function getLineRanges(parsedDiff: ParsedDiff): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []

  for (const hunk of parsedDiff.hunks) {
    const start = hunk.newStart
    const end = hunk.newStart + hunk.newLines - 1
    ranges.push({ start, end })
  }

  return ranges
}

/**
 * Detect if diff has merge conflict markers
 */
function hasMergeConflicts(diff: string): boolean {
  const conflictMarkers = ['<<<<<<<', '=======', '>>>>>>>']
  return conflictMarkers.some((marker) => diff.includes(marker))
}

/**
 * Detect programming language from file path
 */
function detectLanguage(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext ? LANGUAGE_MAP[ext] : undefined
}

/**
 * Check if file should be excluded based on patterns
 */
function shouldExclude(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false
  }

  const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/')

  return patterns.some((pattern) => {
    const normalizedPattern = pattern.toLowerCase().trim()
    // Simple glob matching
    if (normalizedPattern.includes('*')) {
      const regex = new RegExp(
        '^' + normalizedPattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      )
      return regex.test(normalizedPath)
    }
    return normalizedPath.endsWith(normalizedPattern) || normalizedPath.includes(normalizedPattern)
  })
}

/**
 * Filter out files that are binary, excluded, or empty
 *
 * @param diffs - Array of parsed diffs to filter
 * @param options - Filter options
 * @returns Filtered array of diffs
 */
export function filterDiffs(
  diffs: Array<ParsedDiff | null>,
  options: ParseDiffOptions = {}
): ParsedDiff[] {
  return diffs.filter(
    (diff): diff is ParsedDiff =>
      diff !== null &&
      !diff.isBinary &&
      diff.hunks.length > 0 &&
      (diff.additions > 0 || diff.deletions > 0)
  )
}

/**
 * Get summary statistics for multiple diffs
 *
 * @param diffs - Array of parsed diffs
 * @returns Summary object with totals
 */
export function getDiffSummary(diffs: ParsedDiff[]): {
  totalFiles: number
  totalAdditions: number
  totalDeletions: number
  totalChanges: number
  languages: string[]
} {
  const languages = new Set<string>()

  const summary = diffs.reduce(
    (acc, diff) => {
      acc.totalFiles++
      acc.totalAdditions += diff.additions
      acc.totalDeletions += diff.deletions
      acc.totalChanges += diff.additions + diff.deletions
      if (diff.language) {
        languages.add(diff.language)
      }
      return acc
    },
    { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, totalChanges: 0 }
  )

  return {
    ...summary,
    languages: Array.from(languages)
  }
}

/**
 * Chunk a large diff into smaller pieces for processing
 *
 * @param diff - The parsed diff to chunk
 * @param maxHunksPerChunk - Maximum hunks per chunk (default: 50)
 * @returns Array of chunked diffs
 */
export function chunkLargeDiff(
  diff: ParsedDiff,
  maxHunksPerChunk: number = 50
): ParsedDiff[] {
  if (diff.hunks.length <= maxHunksPerChunk) {
    return [diff]
  }

  const chunks: ParsedDiff[] = []
  const totalChunks = Math.ceil(diff.hunks.length / maxHunksPerChunk)

  for (let i = 0; i < totalChunks; i++) {
    const startIdx = i * maxHunksPerChunk
    const endIdx = Math.min(startIdx + maxHunksPerChunk, diff.hunks.length)
    const chunkHunks = diff.hunks.slice(startIdx, endIdx)

    const chunk: ParsedDiff = {
      ...diff,
      hunks: chunkHunks,
      additions: chunkHunks.reduce((sum, hunk) => {
        return sum + hunk.lines.filter((l) => l.type === 'added').length
      }, 0),
      deletions: chunkHunks.reduce((sum, hunk) => {
        return sum + hunk.lines.filter((l) => l.type === 'removed').length
      }, 0)
    }

    chunks.push(chunk)
  }

  return chunks
}

/**
 * Check if a diff is too large and should be chunked
 *
 * @param diff - The parsed diff to check
 * @param maxHunks - Maximum hunks before chunking is recommended
 * @returns true if diff should be chunked
 */
export function shouldChunkDiff(diff: ParsedDiff, maxHunks: number = 50): boolean {
  return diff.hunks.length > maxHunks
}
