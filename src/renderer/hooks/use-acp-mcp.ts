import { useEffect } from 'react'
import { useAcpStore } from '@/stores/acp-store'

/** Load the persisted MCP server registry once at app mount. */
export function useAcpMcp(): void {
  const loadMcpServers = useAcpStore((s) => s.loadMcpServers)
  useEffect(() => {
    void loadMcpServers()
  }, [loadMcpServers])
}
