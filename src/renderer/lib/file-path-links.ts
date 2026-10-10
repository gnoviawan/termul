import { filesystemApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

/** Resolves relative terminal paths against the terminal cwd and active project root. */
export interface FilePathResolutionContext {
  cwd?: string
  projectRoot?: string
}

/** The result of resolving a terminal path candidate to an openable file. */
export type FilePathResolutionResult =
  | {
      ok: true
      path: string
      /**
       * Additional candidates whose `/fs/info` stat was FORBIDDEN
       * (remote peers cannot stat) — tried in order when `openFile`
       * rejects `path`, since we could not verify which one exists.
       */
      deferredPaths?: string[]
    }
  | { ok: false; reason: 'missing-context' | 'not-found' | 'not-file' }

type OpenFilePathFailureReason =
  | Extract<FilePathResolutionResult, { ok: false }>['reason']
  | 'open-failed'

export type OpenFilePathResult =
  | { ok: true }
  | {
      ok: false
      reason: OpenFilePathFailureReason
      message: string
    }

/** A 1-based xterm link range on a single rendered line. */
export interface TerminalPathLinkRange {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

/** A clickable file path link extracted from terminal output. */
export interface TerminalPathLink {
  range: TerminalPathLinkRange
  text: string
  activate: (event: MouseEvent, text: string) => void | Promise<void>
}

const FILE_PATH_LINK_REGEX =
  /(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\|\/)?(?:[^\s\\/:*?"<>|`]+[\\/])+[^\s\\/:*?"<>|`]+(?:\.[A-Za-z0-9_-]+)?(?::\d+(?::\d+)?)?/g

const URI_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

const PATH_PREFIX_REGEX = /^(?:\.{1,2}\/|~\/|[A-Za-z]:\/|\/)/

const DOT_DIRECTORY_REGEX = /^\.[A-Za-z]/

const LINE_COLUMN_SUFFIX_REGEX = /:(\d+)(?::\d+)?$/

const FILE_EXTENSION_REGEX = /\.[^.]+$/

const WRAPPER_PAIRS: Array<[string, string]> = [
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['(', ')'],
  ['[', ']']
]

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/')
}

function looksLikeFilePath(text: string): boolean {
  if (URI_SCHEME_REGEX.test(text)) {
    return false
  }

  return text.includes('/') || text.includes('\\') || /^[A-Za-z]:/.test(text)
}

/**
 * Requires at least one strong path-likeness signal so prose slash-pairs like
 * `text/text` or `2.5/3.0` do not linkify: an explicit path prefix (including
 * `~/`), a `:line[:col]` suffix, a lettered file extension on the final
 * segment (computed after stripping the line suffix), a dot-directory first
 * segment like `.git`, or at least three segments where at least one segment
 * contains a letter.
 */
export function hasPathEvidence(text: string): boolean {
  const normalized = normalizePathSeparators(text)

  if (PATH_PREFIX_REGEX.test(normalized)) {
    return true
  }

  if (LINE_COLUMN_SUFFIX_REGEX.test(normalized)) {
    return true
  }

  const segments = stripLineColumnSuffix(normalized).split('/').filter(Boolean)
  const lastSegment = segments[segments.length - 1] ?? ''
  const extension = lastSegment.match(FILE_EXTENSION_REGEX)?.[0]

  if (extension && /\p{L}/u.test(extension)) {
    return true
  }

  const firstSegment = segments[0] ?? ''

  if (DOT_DIRECTORY_REGEX.test(firstSegment)) {
    return true
  }

  return segments.length >= 3 && segments.some((segment) => /[A-Za-z]/.test(segment))
}

function trimTrailingPathPunctuation(value: string): string {
  let result = value.replace(/[.,;!?]+$/, '')

  for (const [opening, closing] of WRAPPER_PAIRS) {
    while (result.endsWith(closing) && !result.includes(opening)) {
      result = result.slice(0, -1)
    }
  }

  return result
}

function isUrlAdjacentPathMatch(line: string, start: number, text: string): boolean {
  const tokenStart = line.slice(0, start).search(/\S+$/)
  if (tokenStart < 0) {
    return false
  }

  const tokenPrefix = line
    .slice(tokenStart, start + (text.startsWith('/') ? 1 : 0))
    .replace(/^[`"'([{]+/, '')
  return URI_SCHEME_REGEX.test(tokenPrefix)
}

export interface FilePathMatch {
  text: string
  start: number
}

/** Finds file-like path tokens while excluding URL host/path fragments. */
export function findFilePathMatches(line: string): FilePathMatch[] {
  if (!line.includes('/') && !line.includes('\\') && !line.includes(':')) {
    return []
  }

  const matches: FilePathMatch[] = []

  for (const match of line.matchAll(FILE_PATH_LINK_REGEX)) {
    let text = trimTrailingPathPunctuation(match[0])
    let start = match.index ?? -1
    const wrapper = WRAPPER_PAIRS.find(
      ([opening, closing]) => text.startsWith(opening) && line[start + text.length] === closing
    )
    if (wrapper) {
      text = text.slice(wrapper[0].length)
      start += wrapper[0].length
    }

    if (
      !text ||
      !looksLikeFilePath(text) ||
      !hasPathEvidence(text) ||
      start < 0 ||
      isUrlAdjacentPathMatch(line, start, text)
    ) {
      continue
    }

    matches.push({ text, start })
  }

  return matches
}

/** Extracts file-like links from a rendered terminal line for Ctrl/Cmd+Click activation. */
// Range x-coordinates are based on JavaScript string indices. Wide or combining
// terminal characters can render to different cell widths, and this module only
// receives plain text, so it cannot accurately map visual cells here.
export function buildTerminalPathLinks(
  line: string,
  lineNumber: number,
  onActivate: (event: MouseEvent, text: string) => void | Promise<void>
): TerminalPathLink[] {
  return findFilePathMatches(line).map(({ text, start }) => ({
    range: {
      start: { x: start + 1, y: lineNumber },
      end: { x: start + text.length, y: lineNumber }
    },
    text,
    activate: onActivate
  }))
}

function normalizeAbsolutePath(value: string): string {
  const normalized = normalizePathSeparators(value)

  if (normalized.startsWith('//')) {
    return `//${normalized.slice(2).replace(/\/+/g, '/')}`
  }

  return normalized.replace(/\/+/g, '/')
}

function isAbsolutePath(value: string): boolean {
  const normalized = normalizePathSeparators(value)
  return (
    normalized.startsWith('//') || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)
  )
}

function joinPath(base: string, candidate: string): string {
  const normalizedBase = normalizePathSeparators(base).replace(/\/+$/, '')
  const normalizedCandidate = normalizePathSeparators(candidate).replace(/^\/+/, '')
  return normalizeAbsolutePath(`${normalizedBase}/${normalizedCandidate}`)
}

function canonicalizeAbsolutePath(value: string): string | null {
  const normalized = normalizeAbsolutePath(value)

  let root = '/'
  let remainder = normalized

  if (/^[a-zA-Z]:\//.test(normalized)) {
    root = `${normalized.slice(0, 2)}/`
    remainder = normalized.slice(3)
  } else if (normalized.startsWith('//')) {
    const segments = normalized.split('/').filter(Boolean)
    if (segments.length < 2) {
      return null
    }
    root = `//${segments[0]}/${segments[1]}`
    remainder = segments.slice(2).join('/')
  } else if (normalized.startsWith('/')) {
    remainder = normalized.slice(1)
  } else {
    return null
  }

  const parts = remainder.split('/').filter(Boolean)
  const resolvedParts: string[] = []

  for (const part of parts) {
    if (part === '.') {
      continue
    }

    if (part === '..') {
      if (resolvedParts.length === 0) {
        return null
      }
      resolvedParts.pop()
      continue
    }

    resolvedParts.push(part)
  }

  const joinedParts = resolvedParts.join('/')
  const canonicalPath = joinedParts
    ? root === '/'
      ? `/${joinedParts}`
      : normalizeAbsolutePath(`${root}/${joinedParts}`)
    : root

  return canonicalPath
}

function shouldCompareCaseInsensitively(path: string, root: string): boolean {
  return (
    /^[a-zA-Z]:\//.test(path) ||
    /^[a-zA-Z]:\//.test(root) ||
    path.startsWith('//') ||
    root.startsWith('//')
  )
}

function isPathWithinRoot(path: string, root: string): boolean {
  const comparablePath = shouldCompareCaseInsensitively(path, root) ? path.toLowerCase() : path
  const comparableRoot = shouldCompareCaseInsensitively(path, root) ? root.toLowerCase() : root

  if (comparablePath === comparableRoot) {
    return true
  }

  if (comparableRoot === '/') {
    return comparablePath.startsWith('/')
  }

  return comparablePath.startsWith(`${comparableRoot}/`)
}

function getAllowedRoots(context: FilePathResolutionContext): string[] {
  const roots = [context.cwd, context.projectRoot]
    .map((value) => (value ? canonicalizeAbsolutePath(value) : null))
    .filter((value): value is string => Boolean(value))

  return [...new Set(roots)]
}

function buildResolutionCandidates(candidate: string, roots: string[]): string[] {
  if (isAbsolutePath(candidate)) {
    const absoluteCandidate = canonicalizeAbsolutePath(candidate)
    if (!absoluteCandidate) {
      return []
    }

    return roots.some((root) => isPathWithinRoot(absoluteCandidate, root))
      ? [absoluteCandidate]
      : []
  }

  const paths: string[] = []

  for (const root of roots) {
    const resolvedCandidate = canonicalizeAbsolutePath(joinPath(root, candidate))
    if (!resolvedCandidate || !isPathWithinRoot(resolvedCandidate, root)) {
      continue
    }

    if (!paths.includes(resolvedCandidate)) {
      paths.push(resolvedCandidate)
    }
  }

  return paths
}

/** Removes a single layer of wrapping quotes, brackets, or backticks from a path token. */
export function trimWrappedPath(value: string): string {
  const result = value.trim()

  for (const [start, end] of WRAPPER_PAIRS) {
    if (
      result.startsWith(start) &&
      result.endsWith(end) &&
      result.length >= start.length + end.length
    ) {
      return result.slice(start.length, result.length - end.length).trim()
    }
  }

  return result
}

/** Removes trailing :line or :line:column suffixes from a path token. */
export function stripLineColumnSuffix(value: string): string {
  return value.replace(LINE_COLUMN_SUFFIX_REGEX, '')
}

function parseLineColumnSuffix(value: string): { line?: number; column?: number } {
  const match = value.match(/:(\d+)(?::(\d+))?$/)
  if (!match) {
    return {}
  }

  const line = Number.parseInt(match[1], 10)
  const parsedColumn = match[2] ? Number.parseInt(match[2], 10) : null

  return {
    line: Number.isFinite(line) && line > 0 ? line : undefined,
    column:
      parsedColumn !== null && Number.isFinite(parsedColumn) && parsedColumn > 0
        ? parsedColumn
        : undefined
  }
}

/** Normalizes a terminal token into a file path candidate before filesystem resolution. */
export function extractPathCandidate(value: string): string {
  return stripLineColumnSuffix(trimWrappedPath(value))
}

/** Resolves a terminal path token to an existing file using terminal and project context. */
export async function resolveFilePathCandidate(
  rawCandidate: string,
  context: FilePathResolutionContext
): Promise<FilePathResolutionResult> {
  const candidate = extractPathCandidate(rawCandidate)

  if (candidate.endsWith('/') || candidate.endsWith('\\')) {
    return { ok: false, reason: 'not-file' }
  }

  const allowedRoots = getAllowedRoots(context)

  if (allowedRoots.length === 0) {
    return { ok: false, reason: 'missing-context' }
  }

  const absoluteCandidates = buildResolutionCandidates(candidate, allowedRoots)

  if (absoluteCandidates.length === 0) {
    return { ok: false, reason: 'not-found' }
  }

  const infoResults = await Promise.all(
    absoluteCandidates.map(async (absolutePath) => ({
      absolutePath,
      infoResult: await filesystemApi.getFileInfo(absolutePath)
    }))
  )

  let sawDirectoryCandidate = false
  const forbiddenCandidates: string[] = []

  for (const { absolutePath, infoResult } of infoResults) {
    if (!infoResult.success) {
      // `/fs/info` is loopback-guarded server-side while `/fs/read` is
      // deliberately not, so remote peers (shared-live, standalone without
      // --allow-remote-writes) get FORBIDDEN here even when the file exists.
      // FORBIDDEN means "unverifiable", not "missing" — keep the candidate so
      // `openFile` performs the real validation and reports the server's own
      // error if the path is genuinely absent or a directory.
      if (infoResult.code === 'FORBIDDEN') {
        forbiddenCandidates.push(absolutePath)
      }
      continue
    }

    if (infoResult.data.type === 'file') {
      return { ok: true, path: absolutePath }
    }

    sawDirectoryCandidate = true
  }

  if (forbiddenCandidates.length > 0) {
    void logFrontendError({
      level: 'warn',
      source: 'filePathLinks.resolveFilePathCandidate',
      message: `getFileInfo FORBIDDEN; opening ${forbiddenCandidates.length} unverified candidate(s) starting with ${forbiddenCandidates[0]}`
    })
    return { ok: true, path: forbiddenCandidates[0], deferredPaths: forbiddenCandidates.slice(1) }
  }

  return sawDirectoryCandidate
    ? { ok: false, reason: 'not-file' }
    : { ok: false, reason: 'not-found' }
}

function getErrorMessage(
  rawCandidate: string,
  reason: OpenFilePathFailureReason,
  details?: string
): string {
  const candidate = extractPathCandidate(rawCandidate)

  switch (reason) {
    case 'missing-context':
      return `No project or working directory found; set a project/cwd to open paths: ${candidate}`
    case 'not-file':
      return `Path is a directory, not a file: ${candidate}`
    case 'not-found':
      return `File not found: ${candidate}`
    case 'open-failed':
      return details
        ? `Failed to open file: ${candidate} (${details})`
        : `Failed to open file: ${candidate}`
  }
}

/** Opens a resolved file path from terminal output and adds it to the editor workspace. */
export async function openFilePathFromTerminal(
  rawCandidate: string,
  context: FilePathResolutionContext
): Promise<OpenFilePathResult> {
  const resolution = await resolveFilePathCandidate(rawCandidate, context)

  if (!resolution.ok) {
    return {
      ok: false,
      reason: resolution.reason,
      message: getErrorMessage(rawCandidate, resolution.reason)
    }
  }

  const wrappedCandidate = trimWrappedPath(rawCandidate)
  const position = parseLineColumnSuffix(wrappedCandidate)

  let lastError: unknown = null
  for (const candidatePath of [resolution.path, ...(resolution.deferredPaths ?? [])]) {
    try {
      await useEditorStore.getState().openFile(candidatePath)

      if (position.line) {
        useEditorStore
          .getState()
          .updateCursorPosition(candidatePath, position.line, position.column ?? 1)
      }

      useWorkspaceStore.getState().addEditorTab(candidatePath)
      return { ok: true }
    } catch (error) {
      lastError = error
    }
  }

  const details = lastError instanceof Error ? lastError.message : String(lastError)
  return {
    ok: false,
    reason: 'open-failed',
    message: getErrorMessage(rawCandidate, 'open-failed', details)
  }
}
