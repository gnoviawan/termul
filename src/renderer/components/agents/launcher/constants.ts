import type { AuthMethod, McpToolInfo, ProbeStatus } from '@/lib/acp-api'
import type { StoredMcpServer } from '@/lib/acp-mcp-persistence'

/**
 * Stable empty fixtures for the launcher's optional store slices — shared
 * references so `useAcpStore` selectors don't hand back a fresh array/object
 * every render (would loop `useSyncExternalStore`-style equality checks).
 */
export const EMPTY_COMMANDS: [] = []
export const EMPTY_AUTH_METHODS: AuthMethod[] = []

export const EMPTY_MCP_SERVERS: StoredMcpServer[] = []
export const EMPTY_PROBE_STATUS: Record<string, ProbeStatus> = {}
export const EMPTY_MCP_TOOLS: Record<string, McpToolInfo[]> = {}
export const EMPTY_PROBE_ERROR: Record<string, string | undefined> = {}
