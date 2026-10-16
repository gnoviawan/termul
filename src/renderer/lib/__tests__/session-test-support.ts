import type { IpcResult, SessionData } from '@shared/types/ipc.types'
import { vi } from 'vitest'

/** In-memory stand-in for the persistence facade the session API writes through. */
export const fakePersistence = (() => {
  const data = new Map<string, unknown>()
  const ok = (value: unknown): IpcResult<never> => ({ success: true, data: value }) as never
  const api = {
    read: vi.fn(async (key: string): Promise<IpcResult<unknown>> => {
      if (!data.has(key)) {
        return { success: false, error: `Key not found: ${key}`, code: 'KEY_NOT_FOUND' }
      }
      return ok(structuredClone(data.get(key)))
    }),
    write: vi.fn(async (key: string, value: unknown): Promise<IpcResult<void>> => {
      data.set(key, structuredClone(value))
      return ok(undefined)
    }),
    delete: vi.fn(async (key: string): Promise<IpcResult<void>> => {
      data.delete(key)
      return ok(undefined)
    })
  }
  return { data, api }
})()

export function validSessionData(): SessionData {
  return {
    timestamp: new Date().toISOString(),
    terminals: [
      {
        id: 'terminal-123',
        shell: 'bash',
        cwd: '/home/user',
        history: ['ls -la', 'cd /tmp'],
        env: { PATH: '/usr/bin' }
      },
      {
        id: 'terminal-456',
        shell: 'zsh',
        cwd: '/home/user/projects',
        history: [],
        env: undefined
      }
    ],
    workspaces: [
      {
        projectId: 'project-abc',
        activeTerminalId: 'terminal-123',
        terminals: [{ id: 'terminal-123', shell: 'bash', cwd: '/home/user', history: [] }]
      }
    ]
  }
}
