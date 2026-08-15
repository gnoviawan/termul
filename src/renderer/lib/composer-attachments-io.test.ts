import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn(),
  tempDir: vi.fn()
}))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readImage: vi.fn()
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn()
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn()
}))

import { open } from '@tauri-apps/plugin-dialog'
import { i18n } from '@/i18n'
import { isTauriContext } from '@/lib/tauri-runtime'
import { pickAttachmentPaths, writeBytesToTempFile } from './composer-attachments-io'

describe('composer attachment IO localization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauriContext).mockReturnValue(true)
    vi.mocked(open).mockResolvedValue(null)
  })

  it('uses the current language for the native attachment picker title', async () => {
    const previousLanguage = i18n.language
    try {
      await i18n.changeLanguage('en')
      await pickAttachmentPaths()
      expect(open).toHaveBeenLastCalledWith({ multiple: true, title: 'Attach files' })

      await i18n.changeLanguage('zh-CN')
      await pickAttachmentPaths()
      expect(open).toHaveBeenLastCalledWith({ multiple: true, title: '添加文件' })
    } finally {
      await i18n.changeLanguage(previousLanguage)
    }
  })

  it('localizes the desktop-only temp-file error', async () => {
    const previousLanguage = i18n.language
    vi.mocked(isTauriContext).mockReturnValue(false)
    try {
      await i18n.changeLanguage('zh-CN')
      await expect(writeBytesToTempFile(new Uint8Array(), 'image.png')).rejects.toThrow(
        '临时文件写入仅支持桌面端；Web 端请使用内联文件字节'
      )
    } finally {
      await i18n.changeLanguage(previousLanguage)
    }
  })
})
