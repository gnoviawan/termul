/**
 * Path helpers for the mobile Files sheet (`MobileFileExplorer`): normalizing
 * the project root and the listed entries to one comparable form, and deriving
 * the header breadcrumb from them. Pure string work, no I/O except the warning
 * log in `resolveBreadcrumbTarget`.
 *
 * Moved out of `MobileFileExplorer.tsx` (800-line ceiling); the verbatim-prefix
 * strip in `normalizePath` is the only addition (L-20).
 */

import { logFrontendError } from '@/lib/log-api'

const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/

/**
 * Windows verbatim paths (`\\?\C:\x`, `\\?\UNC\srv\share`) arrive as `//?/...`
 * once backslashes are replaced. A Windows-hosted termul-server lists entries
 * that way while the project root is a plain `C:/...`, so without this the
 * entries never sit "within" the root. `//?/C:/x` becomes `C:/x` and
 * `//?/UNC/srv/share/p` becomes `//srv/share/p`; any other path (including an
 * unrecognised `//?/` form) is returned untouched.
 */
function stripVerbatimPrefix(path: string): string {
  if (!path.startsWith('//?/')) return path
  const rest = path.slice('//?/'.length)
  if (/^UNC\//i.test(rest)) return `//${rest.slice('UNC/'.length)}`
  if (/^[A-Za-z]:$/.test(rest)) return `${rest}/`
  if (/^[A-Za-z]:\//.test(rest)) return rest
  return path
}

/** Resolves `.` and `..` segments, keeping a UNC (`//`), posix (`/`) or drive
 * (`C:/`) root; `..` cannot climb above a root. Paths without a dot segment
 * are returned untouched, so every ordinary path normalizes exactly as before. */
function resolveDotSegments(path: string): string {
  if (!DOT_SEGMENT.test(path)) return path
  const root = /^(?:\/\/|[A-Za-z]:\/|\/)/.exec(path)?.[0] ?? ''
  const kept: string[] = []
  for (const segment of path.slice(root.length).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') kept.push(segment)
    else if (kept.length > 0 && kept[kept.length - 1] !== '..') kept.pop()
    else if (!root) kept.push('..')
  }
  return root + kept.join('/')
}

export function normalizePath(path: string): string {
  const normalized = resolveDotSegments(stripVerbatimPrefix(path.replace(/\\/g, '/')))
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized
  return normalized.replace(/\/+$/, '') || '/'
}

function pathIdentity(path: string): string {
  const normalized = normalizePath(path)
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '')
}

/** Case-insensitive comparison form of a path: `pathIdentity` lowercased.
 * Routed through every within-root comparison (`isWithinRoot`, `parentOf`,
 * `isAtRoot`, `navigateBack`) so a casing discrepancy between the stored
 * `rootPath` (config casing, e.g. `e:/proj`) and server-canonicalized entry
 * paths (on-disk casing, e.g. `E:/proj/...`) no longer clamps back
 * navigation to root. Never feeds the stored `currentPath` or any display
 * string — those keep the case-preserving `normalizePath` output. */
export function comparePath(path: string): string {
  return pathIdentity(path).toLowerCase()
}

export function joinPath(parent: string, name: string): string {
  return `${normalizePath(parent).replace(/\/$/, '')}/${name}`
}

export function isWithinRoot(path: string, root: string): boolean {
  const p = comparePath(path)
  const r = comparePath(root)
  if (p === r) return true
  // Drive roots (`c:/`, lowercased from `C:/`) and posix `/` prefix any
  // child without a trailing separator, so check `startsWith(r)` directly
  // for those.
  if (r === '/' || /^[A-Za-z]:\/$/.test(r)) return p.startsWith(r)
  return p.startsWith(`${r}/`)
}

export interface FolderCrumb {
  label: string
  path: string
}

/** Header breadcrumb for a folder below the project root; null at (or outside)
 * the root. Ancestor paths are case-preserving prefixes of `current`; the first
 * segment targets the normalized root itself, so a tap lands on the same path
 * `parentOf` / `navigateBack` reach. Both inputs are `normalizePath` output. */
export function buildFolderCrumbs(
  root: string,
  current: string
): { ancestors: FolderCrumb[]; currentLabel: string } | null {
  if (comparePath(current) === comparePath(root) || !isWithinRoot(current, root)) return null
  // Roots ending in a separator (`/`, `C:/`) already include it.
  const prefixLength = root.endsWith('/') ? root.length : root.length + 1
  const parts = current.slice(prefixLength).split('/').filter(Boolean)
  const currentLabel = parts.pop()
  if (currentLabel === undefined) return null
  const ancestors: FolderCrumb[] = [
    { label: root.split('/').filter(Boolean).at(-1) || root, path: root }
  ]
  let prefix = current.slice(0, prefixLength)
  for (const part of parts) {
    prefix += part
    ancestors.push({ label: part, path: prefix })
    prefix += '/'
  }
  return { ancestors, currentLabel }
}

/** Guard for a breadcrumb tap. Returns the normalized target, or null when the
 * tap must change nothing: a target outside the root (or with no root) is
 * logged as a warning, a tap on the folder already shown is silent. */
export function resolveBreadcrumbTarget(
  path: string,
  rootPath: string | null,
  currentPath: string | null
): string | null {
  const target = normalizePath(path)
  if (!rootPath || !isWithinRoot(target, rootPath)) {
    void logFrontendError({
      level: 'warn',
      source: 'MobileFileExplorer.navigateTo',
      message: rootPath
        ? 'breadcrumb target is outside the project root; ignored'
        : 'breadcrumb tapped without a project root; ignored'
    })
    return null
  }
  if (currentPath && comparePath(currentPath) === comparePath(target)) return null
  return target
}
