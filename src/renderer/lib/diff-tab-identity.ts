/**
 * Diff tab identity (shell revamp AD-7): one tab per
 * `(canonical working copy, repo-relative POSIX new-side path, staged|unstaged)`.
 * Pure and dependency-light so the store, restore and tests share one rule.
 */

import { normalizePath } from '@/lib/working-copy'

export interface DiffTabIdentity {
  /** `normalizePath(workingCopy)`: canonical comparison form of the cwd. */
  workingCopy: string
  /** Repo-relative POSIX path of the new side. */
  path: string
  staged: boolean
}

/** Repo-relative POSIX form of `path`: forward slashes, no leading `./` or `/`, no duplicate slashes. */
function repoRelativePosixPath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/')
  const kept: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    kept.push(segment)
  }
  return kept.join('/')
}

export function diffTabIdentity(cwd: string, path: string, staged: boolean): DiffTabIdentity {
  return { workingCopy: normalizePath(cwd), path: repoRelativePosixPath(path), staged }
}

/** Two independent 32-bit FNV-1a passes (different seeds) joined as 16 hex chars. */
function stableHash(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x9e3779b9
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193)
    h2 = Math.imul(h2 ^ code, 0x85ebca6b)
    h2 ^= h2 >>> 13
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/** Tab id: `diff:` + stable hash of the canonical identity. */
export function diffTabId(cwd: string, path: string, staged: boolean): string {
  const { workingCopy, path: relPath, staged: side } = diffTabIdentity(cwd, path, staged)
  return `diff:${stableHash(JSON.stringify([workingCopy, relPath, side ? 'staged' : 'unstaged']))}`
}

/** Commit diff tab label: `a.ts @ e44b917` (last path segment, short hash). */
export function commitDiffTabLabel(path: string, commit: string): string {
  const segments = path.split('/').filter(Boolean)
  return `${segments[segments.length - 1] ?? path} @ ${commit.slice(0, 7)}`
}

/** Commit Diff tab id: one file at one commit (read-only), in the `diff:` id space so saved ids keep matching. */
export function commitDiffTabId(cwd: string, hash: string, path: string): string {
  const { workingCopy, path: relPath } = diffTabIdentity(cwd, path, false)
  return `diff:${stableHash(JSON.stringify([workingCopy, relPath, 'commit', hash]))}`
}
