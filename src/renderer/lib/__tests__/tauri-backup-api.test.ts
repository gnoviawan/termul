/**
 * Unit tests for tauri-backup-api.ts
 *
 * Focused on createBackup's directory-skip behavior: the backup must copy the
 * userData directory while excluding both the `backups/` folder (its own
 * destination) and the `versions/` rollback store, so backups stay small and
 * cannot silently fail/block the updater download path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DirEntry } from '@tauri-apps/plugin-fs'

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

import { readDir, copyFile, mkdir } from '@tauri-apps/plugin-fs'
import { createBackup, _resetBackupStateForTesting } from '../tauri-backup-api'

function dir(name: string): DirEntry {
  return { name, isDirectory: true, isFile: false, isSymlink: false } as DirEntry
}

function file(name: string): DirEntry {
  return { name, isDirectory: false, isFile: true, isSymlink: false } as DirEntry
}

describe('tauri-backup-api createBackup directory skipping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
