import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'

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
  mkdir: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
  remove: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ size: 0 })),
  writeTextFile: vi.fn(async () => {})
}))

import { mkdir } from '@tauri-apps/plugin-fs'
import { _resetRollbackStateForTesting, keepPreviousVersion } from '../tauri-rollback-api'

describe('tauri-rollback-api localization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetRollbackStateForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('localizes invalid version errors while preserving the version', async () => {
    const previousLanguage = i18n.language
    await i18n.changeLanguage('zh-CN')
    try {
      await expect(keepPreviousVersion('not a version')).resolves.toMatchObject({
        success: false,
        error: '版本格式无效：not a version',
        code: 'VERSION_NOT_FOUND'
      })
    } finally {
      await i18n.changeLanguage(previousLanguage)
    }
  })

  it('localizes preservation failures while preserving the underlying error', async () => {
    const previousLanguage = i18n.language
    await i18n.changeLanguage('zh-CN')
    try {
      vi.mocked(mkdir)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce('Permission denied')

      await expect(keepPreviousVersion('1.2.3')).resolves.toMatchObject({
        success: false,
        error: '保留版本失败：Permission denied',
        code: 'COPY_ERROR'
      })
    } finally {
      await i18n.changeLanguage(previousLanguage)
    }
  })
})
