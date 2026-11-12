import { beforeEach, describe, expect, it, vi } from 'vitest'

// The host store as the web client reaches it through `persistenceApi`.
const host = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  watchers: [] as Array<(change: { exists: boolean; data?: unknown }) => void>
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() }
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => false),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  persistenceApi: {
    read: vi.fn(async (key: string) =>
      host.store.has(key)
        ? { success: true, data: host.store.get(key) }
        : { success: false, error: 'not found', code: 'KEY_NOT_FOUND' }
    ),
    write: vi.fn(async (key: string, value: unknown) => {
      host.store.set(key, value)
      return { success: true, data: undefined }
    }),
    watchShared: vi.fn(
      (_key: string, listener: (change: { exists: boolean; data?: unknown }) => void) => {
        host.watchers.push(listener)
        return () => undefined
      }
    )
  }
}))

import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

const FILES = {
  id: 'files',
  type: 'stdio',
  name: 'Files',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
  enabled: true
} as const

async function openProject(projectId: string): Promise<void> {
  useProjectStore.setState({ activeProjectId: projectId })
  await useAcpStore.getState().loadMcpServers()
}

describe('the web MCP server list is one list for every project', () => {
  beforeEach(() => {
    host.store.clear()
    useAcpStore.setState({ mcpServers: [], mcpServersLoaded: false })
  })

  it('lists a server saved in project A in project B and in a newly registered project C', async () => {
    await openProject('project-a')
    await useAcpStore.getState().saveMcpServer(FILES)

    await openProject('project-b')
    expect(useAcpStore.getState().mcpServers).toEqual([FILES])

    await openProject('project-c')
    expect(useAcpStore.getState().mcpServers).toEqual([FILES])
  })

  it('shows a server another browser saved, so the next save keeps it', async () => {
    await openProject('project-a')
    const added = { ...FILES, id: 'other', name: 'Other' }

    for (const watcher of host.watchers) watcher({ exists: true, data: [FILES, added] })
    expect(useAcpStore.getState().mcpServers).toEqual([FILES, added])

    const edited = { ...FILES, args: ['-y', 'another-server'] }
    for (const watcher of host.watchers) watcher({ exists: true, data: [edited, added] })
    expect(useAcpStore.getState().mcpToolsLoaded.files).toBe(false)

    const mine = { ...FILES, id: 'mine', name: 'Mine' }
    await useAcpStore.getState().saveMcpServer(mine)
    expect((host.store.get('acp/mcp-servers') as unknown[]).length).toBe(3)
  })
})
