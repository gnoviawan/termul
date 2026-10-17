import { Network } from '@/components/icons'
import { McpServersSettings } from '@/components/settings/McpServersSettings'
import { SettingsSection } from '@/components/settings/SettingsLayout'

export function McpServersSection(): React.JSX.Element {
  return (
    <SettingsSection id="mcp-servers">
      <div className="space-y-4 border-b border-border pb-6">
        <div className="w-full">
          <div className="flex items-center gap-2">
            <Network size={18} className="text-primary" />
            <h2 className="text-lg font-medium text-foreground">MCP Servers</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure global MCP servers for capability-aware injection into new chats.
          </p>
        </div>
        <div className="w-full">
          <McpServersSettings />
        </div>
      </div>
    </SettingsSection>
  )
}
