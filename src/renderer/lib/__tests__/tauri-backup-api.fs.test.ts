/**
 * createBackup against a real temp directory. The plugin-fs stand-ins mirror
 * tauri-plugin-fs 2.5.1: `mkdir` is `DirBuilder` (recursive only when asked,
 * so an existing path succeeds only with `recursive`), `remove` with
 * `recursive` unlinks a symlink instead of following it, and `readDir` reports
 * a link as `isSymlink`. The failure-path delete must only ever remove the
 * folder the failing attempt created.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ appData: '', failCopyOf: '' }))

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => harness.appData)
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: vi.fn(async () => ({
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      save: vi.fn(async () => {})
    }))
  }
}))

vi.mock('@tauri-apps/plugin-fs', async () => {
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  return {
    readDir: vi.fn(async (dir: string) =>
      nodeFs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymlink: d.isSymbolicLink()
      }))
    ),
    copyFile: vi.fn(async (src: string, dest: string) => {
      if (nodePath.basename(src) === harness.failCopyOf) {
        throw `failed to open file at path: ${src} with error: Permission denied (os error 13)`
      }
      nodeFs.copyFileSync(src, dest)
    }),
    mkdir: vi.fn(async (dir: string, options?: { recursive?: boolean }) => {
      nodeFs.mkdirSync(dir, { recursive: options?.recursive ?? false })
    }),
    remove: vi.fn(async (target: string, options?: { recursive?: boolean }) => {
      const meta = nodeFs.lstatSync(target)
      if (meta.isFile() || meta.isSymbolicLink()) nodeFs.unlinkSync(target)
      else if (options?.recursive) nodeFs.rmSync(target, { recursive: true })
      else nodeFs.rmdirSync(target)
    }),
    writeTextFile: vi.fn(async (file: string, text: string) => nodeFs.writeFileSync(file, text)),
    readTextFile: vi.fn(async (file: string) => nodeFs.readFileSync(file, 'utf8')),
    stat: vi.fn(async (file: string) => ({ size: nodeFs.statSync(file).size })),
    rename: vi.fn(async (from: string, to: string) => nodeFs.renameSync(from, to))
  }
})

vi.mock('../log-api', () => ({
  logFrontendError: vi.fn(async () => {})
}))

import { _resetBackupStateForTesting, createBackup } from '../tauri-backup-api'

const BACKUP_ID = 1_800_000_000_000

function tree(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .map((d) => path.relative(root, path.join(d.parentPath, d.name)))
    .sort()
}

describe('createBackup failure cleanup on a real filesystem', () => {
  let sandbox: string
  let backups: string

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'termul-backup-'))
    harness.appData = path.join(sandbox, 'appdata')
    harness.failCopyOf = 'unreadable.txt'
    backups = path.join(harness.appData, 'backups')
    fs.mkdirSync(path.join(harness.appData, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(harness.appData, 'settings.json'), '{}')
    fs.writeFileSync(path.join(harness.appData, 'projects', 'a.json'), '{"a":1}')
    fs.writeFileSync(path.join(harness.appData, 'unreadable.txt'), 'secret')
    vi.spyOn(Date, 'now').mockReturnValue(BACKUP_ID)
    _resetBackupStateForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(sandbox, { recursive: true, force: true })
  })

  it('removes only the folder the failed attempt created', async () => {
    fs.mkdirSync(path.join(backups, '1700000000000'), { recursive: true })
    fs.writeFileSync(path.join(backups, '1700000000000', 'backup-info.json'), '{}')
    const appDataBefore = tree(harness.appData)

    const result = await createBackup()

    expect(result.success).toBe(false)
    expect(tree(backups)).toEqual(['1700000000000', '1700000000000/backup-info.json'])
    expect(tree(harness.appData)).toEqual(appDataBefore)
  })

  it('leaves an existing backup with the same id untouched', async () => {
    const existing = path.join(backups, String(BACKUP_ID))
    fs.mkdirSync(existing, { recursive: true })
    fs.writeFileSync(path.join(existing, 'backup-info.json'), '{"id":"existing"}')
    fs.writeFileSync(path.join(existing, 'settings.json'), '{"old":true}')

    const result = await createBackup()

    expect(result.success).toBe(false)
    expect(tree(existing)).toEqual(['backup-info.json', 'settings.json'])
    expect(fs.readFileSync(path.join(existing, 'backup-info.json'), 'utf8')).toBe(
      '{"id":"existing"}'
    )
  })

  it('does not write through or delete a link sitting at the backup path', async () => {
    const outside = path.join(sandbox, 'elsewhere')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    fs.mkdirSync(backups, { recursive: true })
    fs.symlinkSync(outside, path.join(backups, String(BACKUP_ID)), 'dir')

    const result = await createBackup()

    expect(result.success).toBe(false)
    expect(tree(outside)).toEqual(['keep.txt'])
    expect(fs.readdirSync(backups)).toEqual([String(BACKUP_ID)])
    expect(fs.lstatSync(path.join(backups, String(BACKUP_ID))).isSymbolicLink()).toBe(true)
  })

  it('keeps a successful backup and its contents', async () => {
    harness.failCopyOf = ''

    const result = await createBackup()

    expect(result.success).toBe(true)
    expect(tree(path.join(backups, String(BACKUP_ID)))).toEqual([
      'backup-info.json',
      'projects',
      'projects/a.json',
      'settings.json',
      'unreadable.txt'
    ])
  })
})
