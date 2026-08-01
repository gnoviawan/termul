import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { acpHistoryApi } from './acp-history-api'
import type { SessionPayload } from './acp-history-persistence'

const stored: SessionPayload = {
  metadata: {
    id: 's-1',
    agentId: 'a-1',
    title: 'Chat',
    cwd: '/p',
    projectId: 'p-1',
    createdAt: 1,
    lastActivityAt: 2,
    messageCount: 0,
    status: 'closed'
  },
  messages: []
}

beforeEach(() => vi.clearAllMocks())

describe('acpHistoryApi command contract', () => {
  it.each([
    ['list', 'acp_history_list', undefined, { sessions: [], legacyImportComplete: false }],
    ['get', 'acp_history_get', { sessionId: 's-1' }, stored],
    ['save', 'acp_history_save', { sessionId: 's-1', payload: stored }, undefined],
    ['delete', 'acp_history_delete', { sessionId: 's-1' }, undefined],
    ['flush', 'acp_history_flush', undefined, undefined],
    ['markLegacyImportComplete', 'acp_history_mark_legacy_import_complete', undefined, undefined]
  ] as const)('invokes %s with the exact command and args', async (method, command, args, data) => {
    vi.mocked(invoke).mockResolvedValueOnce({ success: true, data })
    if (method === 'get') await acpHistoryApi.get('s-1')
    else if (method === 'save') await acpHistoryApi.save('s-1', stored)
    else if (method === 'delete') await acpHistoryApi.delete('s-1')
    else await acpHistoryApi[method]()
    expect(invoke).toHaveBeenCalledWith(command, args)
  })

  it('surfaces structured command failures', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      success: false,
      error: 'disk full',
      code: 'ACP_HISTORY_SAVE_FAILED'
    })
    await expect(acpHistoryApi.save('s-1', stored)).rejects.toThrow('disk full')
  })

  it('surfaces invoke transport failures', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('invoke unavailable'))
    await expect(acpHistoryApi.list()).rejects.toThrow('invoke unavailable')
  })
})
