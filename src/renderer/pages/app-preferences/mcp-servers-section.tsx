import { Network } from '@/components/icons'
import { McpServersSettings } from '@/components/settings/McpServersSettings'
import { SettingsSection } from '@/components/settings/SettingsLayout'

export function McpServersSection(): React.JSX.Element {
  return (
    <SettingsSection id="mcp-servers">
      <div className="flex flex-col gap-6 border-b border-border pb-6 md:flex-row md:items-start">
        <div className="w-full pt-1 md:w-1/3">
          <div className="flex items-center gap-2">
            <Network size={18} className="text-primary" />
            <h2 className="text-lg font-medium text-foreground">MCP Servers</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure global MCP servers for capability-aware injection into new chats.
          </p>
        </div>
        <div className="w-full md:w-2/3">
          <McpServersSettings />
        </div>
      </div>
    </SettingsSection>
  )
}
