/**
 * Pure file-path token matching shared by terminal links and chat prose.
 * No store or filesystem imports, so non-DOM clients can load it alone.
 */

const FILE_PATH_LINK_REGEX =
  /(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\|\/)?(?:[^\s\\/:*?"<>|`]+[\\/])+[^\s\\/:*?"<>|`]+(?:\.[A-Za-z0-9_-]+)?(?::\d+(?::\d+)?)?/g

const URI_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

const PATH_PREFIX_REGEX = /^(?:\.{1,2}\/|~\/|[A-Za-z]:\/|\/)/

const DOT_DIRECTORY_REGEX = /^\.[A-Za-z]/

export const LINE_POSITION_SUFFIX_REGEX =
  /(?::(?<line>\d+)(?::(?<column>\d+))?|#L(?<fragmentLine>\d+)(?:C(?<fragmentColumn>\d+))?(?:-L?\d+(?:C\d+)?)?)$/i

const FILE_EXTENSION_REGEX = /\.[^.]+$/

export const WRAPPER_PAIRS: Array<[string, string]> = [
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['(', ')'],
  ['[', ']']
]

export function normalizePathSeparators(value: string): string {
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

  if (LINE_POSITION_SUFFIX_REGEX.exec(normalized)?.groups?.line !== undefined) {
    return true
  }

  const segments = stripLinePosition(normalized).split('/').filter(Boolean)
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

export function stripLinePosition(value: string): string {
  return value.replace(LINE_POSITION_SUFFIX_REGEX, '')
}
