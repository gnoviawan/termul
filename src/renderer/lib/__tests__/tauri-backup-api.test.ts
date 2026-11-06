/**
 * Unit tests for tauri-backup-api.ts
 *
 * Focused on createBackup's directory-skip behavior: the backup must copy the
 * userData directory while excluding both the `backups/` folder (its own
 * destination) and the `versions/` rollback store, so backups stay small and
 * cannot silently fail/block the updater download path.
 */

import type { DirEntry } from '@tauri-apps/plugin-fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/appdata')
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: vi.fn(async () => ({
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
      save: vi.fn(async () => {})
    }))
  }
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(async () => [] as DirEntry[]),
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ size: 0 }))
}))

vi.mock('../log-api', () => ({
  logFrontendError: vi.fn(async () => {})
}))

import { copyFile, mkdir, readDir, remove } from '@tauri-apps/plugin-fs'
import { Store } from '@tauri-apps/plugin-store'
import { logFrontendError } from '../log-api'
import { _resetBackupStateForTesting, createBackup } from '../tauri-backup-api'

function dir(name: string): DirEntry {
  return { name, isDirectory: true, isFile: false, isSymlink: false } as DirEntry
}

function file(name: string): DirEntry {
  return { name, isDirectory: false, isFile: true, isSymlink: false } as DirEntry
}

// readDir does not follow links: a link to a directory reports
// isDirectory=false, isFile=false, isSymlink=true.
function symlink(name: string): DirEntry {
  return { name, isDirectory: false, isFile: false, isSymlink: true } as DirEntry
}

function rejectNonRegularFiles(entries: Map<string, DirEntry>) {
  vi.mocked(copyFile).mockImplementation(async (src: string | URL) => {
    const entry = entries.get(String(src))
    if (!entry?.isFile) {
      throw 'the source path is neither a regular file nor a symlink to a regular file'
    }
  })
}

describe('tauri-backup-api createBackup directory skipping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(copyFile).mockImplementation(async () => {})
    _resetBackupStateForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips the backups and versions directories but copies other content', async () => {
    const topLevel: DirEntry[] = [
      dir('backups'),
      dir('versions'),
      dir('projects'),
      file('settings.json')
    ]

    // First readDir call enumerates the userData root; subsequent calls (size
    // calc, file count, cleanup) read the freshly created backup tree.
    vi.mocked(readDir).mockImplementation(async (path: string | URL) => {
      const p = String(path)
      if (p === '/appdata') return topLevel
      return []
    })

    const result = await createBackup()

    expect(result.success).toBe(true)

    // The destination backup root is created via mkdir; the `projects` dir is
    // recursively copied (its destination dir is created via mkdir), while
    // `versions` is never recreated as a copy destination.
    const mkdirPaths = vi.mocked(mkdir).mock.calls.map((c) => String(c[0]))
    expect(mkdirPaths.some((p) => p.endsWith('/projects'))).toBe(true)
    expect(mkdirPaths.some((p) => p.endsWith('/versions'))).toBe(false)

    // The top-level file is copied; nothing under versions/ or backups/ is.
    const copyDestPaths = vi.mocked(copyFile).mock.calls.map((c) => String(c[1]))
    expect(copyDestPaths.some((p) => p.endsWith('/settings.json'))).toBe(true)
    expect(copyDestPaths.some((p) => p.includes('/versions'))).toBe(false)

    const copySrcPaths = vi.mocked(copyFile).mock.calls.map((c) => String(c[0]))
    expect(copySrcPaths.some((p) => p.includes('/appdata/versions'))).toBe(false)
    expect(copySrcPaths.some((p) => p.includes('/appdata/backups'))).toBe(false)
  })

  it('skips symlinked Claude account entries instead of failing the backup (#1669)', async () => {
    const tree: Record<string, DirEntry[]> = {
      '/appdata': [dir('claude-accounts'), file('settings.json')],
      '/appdata/claude-accounts': [dir('acct-1')],
      '/appdata/claude-accounts/acct-1': [
        file('.claude.json'),
        symlink('plans'),
        symlink('settings.json')
      ]
    }
    const byPath = new Map<string, DirEntry>()
    for (const [parent, entries] of Object.entries(tree)) {
      for (const entry of entries) byPath.set(`${parent}/${entry.name}`, entry)
    }
    rejectNonRegularFiles(byPath)
    vi.mocked(readDir).mockImplementation(async (path: string | URL) => tree[String(path)] ?? [])

    const result = await createBackup()

    expect(result.success).toBe(true)
    const copySrcPaths = vi.mocked(copyFile).mock.calls.map((c) => String(c[0]))
    expect(copySrcPaths).toContain('/appdata/claude-accounts/acct-1/.claude.json')
    expect(copySrcPaths).toContain('/appdata/settings.json')
    expect(copySrcPaths.some((p) => p.endsWith('/acct-1/plans'))).toBe(false)
    expect(copySrcPaths.some((p) => p.endsWith('/acct-1/settings.json'))).toBe(false)

    const warning = vi
      .mocked(logFrontendError)
      .mock.calls.map((c) => c[0])
      .find((payload) => payload.level === 'warn')
    expect(warning?.message).toContain('claude-accounts/acct-1/plans')
    expect(warning?.message).not.toContain('/appdata')
  })

  it('skips a top-level symlink in the userData root', async () => {
    const tree: Record<string, DirEntry[]> = {
      '/appdata': [symlink('linked-dir'), file('settings.json')]
    }
    const byPath = new Map<string, DirEntry>()
    for (const [parent, entries] of Object.entries(tree)) {
      for (const entry of entries) byPath.set(`${parent}/${entry.name}`, entry)
    }
    rejectNonRegularFiles(byPath)
    vi.mocked(readDir).mockImplementation(async (path: string | URL) => tree[String(path)] ?? [])

    const result = await createBackup()

    expect(result.success).toBe(true)
    const copySrcPaths = vi.mocked(copyFile).mock.calls.map((c) => String(c[0]))
    expect(copySrcPaths).toEqual(['/appdata/settings.json'])
  })

  it('leaves re-downloadable data and data-lock sidecars out of the backup (#1431)', async () => {
    const tree: Record<string, DirEntry[]> = {
      '/appdata': [
        file('.termul.lock'),
        file('store.json'),
        file('store.json.lock'),
        dir('acp-sessions'),
        dir('acp-registry-binaries'),
        dir('acp-catalog'),
        dir('mcp-catalog'),
        dir('browser-agent-profile'),
        dir('browser-sessions'),
        dir('browser-artifacts')
      ],
      '/appdata/acp-sessions': [file('.termul.lock'), file('session-1.json'), file('yarn.lock')],
      '/appdata/acp-registry-binaries': [dir('codex')],
      '/appdata/acp-registry-binaries/codex': [file('codex.exe')]
    }
    vi.mocked(readDir).mockImplementation(async (path: string | URL) => tree[String(path)] ?? [])

    const result = await createBackup()

    expect(result.success).toBe(true)
    const copySrcPaths = vi.mocked(copyFile).mock.calls.map((c) => String(c[0]))
    expect(copySrcPaths.sort()).toEqual([
      '/appdata/acp-sessions/session-1.json',
      '/appdata/acp-sessions/yarn.lock',
      '/appdata/store.json'
    ])
    const readPaths = vi.mocked(readDir).mock.calls.map((c) => String(c[0]))
    expect(readPaths.some((p) => p.startsWith('/appdata/acp-registry-binaries'))).toBe(false)
    expect(readPaths.some((p) => p.startsWith('/appdata/browser-'))).toBe(false)
    // Lock sidecars are left out on purpose, not reported as skipped links.
    expect(vi.mocked(logFrontendError)).not.toHaveBeenCalled()
  })

  it('still fails the backup when a regular file cannot be copied', async () => {
    vi.mocked(readDir).mockImplementation(async (path: string | URL) =>
      String(path) === '/appdata' ? [file('settings.json')] : []
    )
    vi.mocked(copyFile).mockRejectedValueOnce('permission denied')

    const result = await createBackup()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('permission denied')
    }
  })

  it('removes the partial backup folder it created when the copy fails', async () => {
    vi.mocked(readDir).mockImplementation(async (path: string | URL) =>
      String(path) === '/appdata' ? [file('settings.json')] : []
    )
    vi.mocked(copyFile).mockRejectedValueOnce('permission denied')

    const result = await createBackup()

    expect(result.success).toBe(false)

    const createdPath = String(vi.mocked(mkdir).mock.calls[1]?.[0])
    expect(createdPath).toMatch(/^\/appdata\/backups\/\d+$/)
    const removeCalls = vi.mocked(remove).mock.calls
    expect(removeCalls).toHaveLength(1)
    expect(String(removeCalls[0][0])).toBe(createdPath)
    expect(removeCalls[0][1]).toEqual({ recursive: true })
  })

  it('reports the original failure and logs when removing the partial folder also fails', async () => {
    vi.mocked(readDir).mockImplementation(async (path: string | URL) =>
      String(path) === '/appdata' ? [file('settings.json')] : []
    )
    vi.mocked(copyFile).mockRejectedValueOnce('permission denied')
    vi.mocked(remove).mockRejectedValueOnce('folder in use')

    const result = await createBackup()

    expect(result.success).toBe(false)
    if (!result.success) {
      // The original copy failure is still what the caller sees.
      expect(result.error).toContain('permission denied')
    }

    const warning = vi
      .mocked(logFrontendError)
      .mock.calls.map((c) => c[0])
      .find((payload) => payload.level === 'warn')
    expect(warning?.message).toContain('failed to remove partial backup folder')
    expect(warning?.message).toContain('folder in use')
  })

  it('does not remove anything when a successful backup leaves no partial folder', async () => {
    vi.mocked(readDir).mockImplementation(async (path: string | URL) =>
      String(path) === '/appdata' ? [file('settings.json')] : []
    )

    const result = await createBackup()

    expect(result.success).toBe(true)
    expect(vi.mocked(remove)).not.toHaveBeenCalled()
  })

  it('keeps a completed backup when a step after backup-info.json fails', async () => {
    vi.mocked(readDir).mockImplementation(async (path: string | URL) =>
      String(path) === '/appdata' ? [file('settings.json')] : []
    )
    // getAppVersion swallows the first load failure; the second one hits the
    // metadata write that runs after backup-info.json is written.
    vi.mocked(Store.load)
      .mockRejectedValueOnce('store unavailable')
      .mockRejectedValueOnce('store unavailable')

    const result = await createBackup()

    expect(result.success).toBe(false)
    expect(vi.mocked(remove)).not.toHaveBeenCalled()
  })
})
