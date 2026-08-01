import type { IpcResult } from '@shared/types/ipc.types'
import { invoke } from '@tauri-apps/api/core'
import type { SessionIndexEntry, SessionPayload } from '@/lib/acp-history-persistence'

export interface DesktopHistoryListResult {
  sessions: SessionIndexEntry[]
  legacyImportComplete: boolean
}

async function invokeHistory<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  let result: IpcResult<T>
  try {
    result = await invoke<IpcResult<T>>(command, args)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  if (!result.success) throw new Error(result.error)
  return result.data
}

export const acpHistoryApi = {
  list(): Promise<DesktopHistoryListResult> {
    return invokeHistory<DesktopHistoryListResult>('acp_history_list')
  },

  get(sessionId: string): Promise<SessionPayload | null> {
    return invokeHistory<SessionPayload | null>('acp_history_get', { sessionId })
  },

  async save(sessionId: string, payload: SessionPayload): Promise<void> {
    await invokeHistory<void>('acp_history_save', { sessionId, payload })
  },

  async delete(sessionId: string): Promise<void> {
    await invokeHistory<void>('acp_history_delete', { sessionId })
  },

  async flush(): Promise<void> {
    await invokeHistory<void>('acp_history_flush')
  },

  async markLegacyImportComplete(): Promise<void> {
    await invokeHistory<void>('acp_history_mark_legacy_import_complete')
  }
}
