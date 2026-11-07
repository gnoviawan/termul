import { toast } from 'sonner'
import { useReloadChat } from '@/hooks/use-reload-chat'
import { type AcpSession, useAcpStore } from '@/stores/acp-store'
import { registryMcpServersMatch } from '@/stores/acp-store/registry-mcp-fingerprints'
import type { McpServerListProps } from '../McpServerList'
import type { ConnectorsHost } from './connectors-menu-model'

/**
 * The chat composer's connectors (the project's MCP servers): one set of props
 * for the desktop `+` menu and the phone `+` sheet. A toggle edits the
 * project-wide list (optimistic, rolled back on a failed save); the running
 * chat keeps the servers it started with until it is reloaded.
 */
export function useChatConnectors(session: AcpSession): {
  connectors: Omit<McpServerListProps, 'listClassName'>
  host: ConnectorsHost
} {
  const chatReload = useReloadChat(session.id)
  const mcpServers = useAcpStore((s) => s.mcpServers)
  const setMcpServerEnabled = useAcpStore((s) => s.setMcpServerEnabled)
  const probeStatus = useAcpStore((s) => s.mcpProbeStatus)
  const probeError = useAcpStore((s) => s.mcpProbeError)
  const tools = useAcpStore((s) => s.mcpTools)
  const loadMcpTools = useAcpStore((s) => s.loadMcpTools)
  const capabilities = useAcpStore((s) =>
    session.agentId ? s.agents?.[session.agentId]?.capabilities : undefined
  )
  // A chat with no recorded fingerprint (reopened from history) may be
  // stale, so it keeps offering the reload. Not memoized: a reload records
  // the fingerprint outside the store, and the reload state change re-renders.
  const stale = registryMcpServersMatch(session.id, mcpServers, capabilities) !== true
  return {
    connectors: {
      // Prefer the session's own count; older sessions fall back to the list.
      count: session.mcpServerCount ?? mcpServers.length,
      servers: mcpServers,
      onToggle: (id: string, enabled: boolean) => {
        void setMcpServerEnabled(id, enabled).catch(() => {
          toast.error('Could not update the MCP server. Your previous setting was restored.')
        })
      },
      probeStatus,
      probeError,
      tools,
      onLoadTools: (id: string) => {
        void loadMcpTools(id)
      },
      // Only a stale chat offers the reload, as on the desktop menu.
      onReloadChat: stale ? chatReload.reload : undefined,
      reloadDisabled: chatReload.disabled,
      reloadDisabledReason: chatReload.reason,
      reloading: chatReload.reloading
    },
    host: stale ? 'chat-stale' : 'chat-current'
  }
}
