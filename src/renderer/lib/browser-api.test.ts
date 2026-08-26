import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

import { invoke } from '@tauri-apps/api/core'
import { browserTabInjectAgentation } from './browser-api'

describe('browser-api agentation wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('browserTabInjectAgentation', () => {
    it('invokes browser_tab_inject_agentation with tabId', async () => {
      vi.mocked(invoke).mockResolvedValue({ success: true, data: undefined })
      await browserTabInjectAgentation('tab-1')
      expect(invoke).toHaveBeenCalledWith('browser_tab_inject_agentation', { tabId: 'tab-1' })
    })

    it('returns success result', async () => {
      vi.mocked(invoke).mockResolvedValue({ success: true, data: undefined })
      const result = await browserTabInjectAgentation('tab-1')
      expect(result.success).toBe(true)
    })
  })
})
